import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Lesson = {
  id: number; ownerId: number; role: "student" | "teacher"; title: string; groupName: string | null;
  teacherName: string | null; room: string | null; weekday: number; startTime: string; endTime: string;
  weekKind: "odd" | "even" | "every"; reminderMinutes: number; notificationsEnabled: boolean;
};

export type SqliteDatabase = Database.Database;

export function openDatabase(path: string): SqliteDatabase {
  const inMemory = path === ":memory:" || path.startsWith("file::memory:");
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (!inMemory) db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS profiles (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', timezone TEXT NOT NULL DEFAULT 'Europe/Chisinau');
    CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, group_name TEXT, teacher_name TEXT, room TEXT, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, week_kind TEXT NOT NULL DEFAULT 'every', reminder_minutes INTEGER NOT NULL DEFAULT 15, notifications_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS delivered_reminders (lesson_id INTEGER NOT NULL, occurrence_key TEXT NOT NULL, PRIMARY KEY (lesson_id, occurrence_key));
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, role TEXT);
    -- Owners whose existing teacher-lesson groups were imported once into the Teacher Catalog (groupSync.ts).
    CREATE TABLE IF NOT EXISTS catalog_group_sync (owner_id INTEGER PRIMARY KEY, synced_at TEXT NOT NULL);`);
  migrateLegacySchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS lessons_owner_idx ON lessons(owner_id, weekday, start_time);
    CREATE INDEX IF NOT EXISTS lessons_weekday_idx ON lessons(weekday) WHERE notifications_enabled=1;
    CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications(owner_id, id);`);
  return db;
}

const columnsOf = (db: SqliteDatabase, table: string) => new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));

/**
 * Brings databases created by older versions up to the current schema without losing rows.
 * Lessons stored without a valid role are kept and placed in the Student schedule (the
 * historical default), so they stay visible; teacher-like values are kept as Profesor.
 */
function migrateLegacySchema(db: SqliteDatabase) {
  const additions: Array<[table: string, column: string, definition: string]> = [
    ["profiles", "role", "TEXT NOT NULL DEFAULT 'student'"],
    ["profiles", "student_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["profiles", "teacher_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["profiles", "reminders_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["lessons", "role", "TEXT NOT NULL DEFAULT 'student'"],
    ["lessons", "week_kind", "TEXT NOT NULL DEFAULT 'every'"],
    ["lessons", "reminder_minutes", "INTEGER NOT NULL DEFAULT 15"],
    ["lessons", "notifications_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["lessons", "updated_at", "TEXT"],
    ["notifications", "role", "TEXT"]
  ];
  db.transaction(() => {
    for (const [table, column, definition] of additions) {
      if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    const normaliseRole = (table: string) => db.exec(`UPDATE ${table} SET role = CASE WHEN lower(trim(role)) IN ('teacher','profesor') THEN 'teacher' ELSE 'student' END
      WHERE role IS NULL OR role NOT IN ('student','teacher')`);
    normaliseRole("lessons");
    normaliseRole("profiles");
    // Profile mode rules (see profile.ts): at least one mode enabled and the active role is an enabled mode.
    db.exec(`UPDATE profiles SET student_enabled=1 WHERE NOT student_enabled AND NOT teacher_enabled`);
    db.exec(`UPDATE profiles SET role='teacher' WHERE role='student' AND NOT student_enabled AND teacher_enabled`);
    db.exec(`UPDATE profiles SET role='student' WHERE role='teacher' AND NOT teacher_enabled AND student_enabled`);
    db.exec(`UPDATE lessons SET week_kind = CASE WHEN lower(trim(week_kind)) IN ('odd','impara','impară') THEN 'odd' WHEN lower(trim(week_kind)) IN ('even','para','pară') THEN 'even' ELSE 'every' END
      WHERE week_kind IS NULL OR week_kind NOT IN ('odd','even','every')`);
    // Times written as "9:30" by older clients break ordering and the end > start comparison.
    db.exec(`UPDATE lessons SET start_time = '0' || start_time WHERE start_time GLOB '[0-9]:[0-5][0-9]*'`);
    db.exec(`UPDATE lessons SET end_time = '0' || end_time WHERE end_time GLOB '[0-9]:[0-5][0-9]*'`);
    db.exec(`UPDATE lessons SET start_time = substr(start_time, 1, 5) WHERE length(start_time) > 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]:*'`);
    db.exec(`UPDATE lessons SET end_time = substr(end_time, 1, 5) WHERE length(end_time) > 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]:*'`);
  })();
}

export const LESSON_COLUMNS = "id, owner_id AS ownerId, role, title, group_name AS groupName, teacher_name AS teacherName, room, weekday, start_time AS startTime, end_time AS endTime, week_kind AS weekKind, reminder_minutes AS reminderMinutes, notifications_enabled AS notificationsEnabled";

type LessonRow = Omit<Lesson, "notificationsEnabled"> & { notificationsEnabled: number | boolean };
export const toLesson = (row: LessonRow): Lesson => ({ ...row, notificationsEnabled: Boolean(row.notificationsEnabled) });

/** All lessons of the owner, or only one schedule (Student / Profesor) when `role` is given. */
export function lessonRows(db: SqliteDatabase, ownerId: number, role?: Lesson["role"]): Lesson[] {
  const rows = role
    ? db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE owner_id=? AND role=? ORDER BY weekday,start_time`).all(ownerId, role)
    : db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE owner_id=? ORDER BY weekday,start_time`).all(ownerId);
  return (rows as LessonRow[]).map(toLesson);
}

export function lessonById(db: SqliteDatabase, ownerId: number, id: number | bigint): Lesson | undefined {
  const row = db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE id=? AND owner_id=?`).get(id, ownerId) as LessonRow | undefined;
  return row && toLesson(row);
}

/** `role` ties a notification to one schedule; null means it is shown in both modes. */
export function addNotification(db: SqliteDatabase, ownerId: number, kind: "reminder" | "system", title: string, body: string, role: Lesson["role"] | null = null) {
  db.prepare("INSERT INTO notifications (owner_id, kind, title, body, role) VALUES (?,?,?,?,?)").run(ownerId, kind, title, body, role);
}

export function upsertProfile(db: SqliteDatabase, user: { id: number; first_name: string; last_name?: string }) {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim().slice(0, 128) || "Utilizator";
  db.prepare("INSERT INTO profiles (telegram_id, display_name) VALUES (?, ?) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name WHERE profiles.display_name IS NOT excluded.display_name")
    .run(user.id, displayName);
}

/** Removes reminder bookkeeping and old notifications so the database does not grow without bound. */
export function pruneDatabase(db: SqliteDatabase, today: string, reminderKeepDays = 14, notificationKeepDays = 180) {
  const cutoff = (days: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const reminders = db.prepare("DELETE FROM delivered_reminders WHERE occurrence_key < ? OR lesson_id NOT IN (SELECT id FROM lessons)").run(cutoff(reminderKeepDays)).changes;
  const notifications = db.prepare("DELETE FROM notifications WHERE created_at < ?").run(cutoff(notificationKeepDays)).changes;
  return { reminders, notifications };
}
