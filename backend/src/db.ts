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
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const profileColumns = new Set((db.pragma("table_info(profiles)") as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of [["student_enabled", "INTEGER NOT NULL DEFAULT 1"], ["teacher_enabled", "INTEGER NOT NULL DEFAULT 1"]]) {
    if (!profileColumns.has(name)) db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS lessons_owner_idx ON lessons(owner_id, weekday, start_time);
    CREATE INDEX IF NOT EXISTS lessons_weekday_idx ON lessons(weekday) WHERE notifications_enabled=1;
    CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications(owner_id, id);`);
  return db;
}

export const LESSON_COLUMNS = "id, owner_id AS ownerId, role, title, group_name AS groupName, teacher_name AS teacherName, room, weekday, start_time AS startTime, end_time AS endTime, week_kind AS weekKind, reminder_minutes AS reminderMinutes, notifications_enabled AS notificationsEnabled";

type LessonRow = Omit<Lesson, "notificationsEnabled"> & { notificationsEnabled: number | boolean };
export const toLesson = (row: LessonRow): Lesson => ({ ...row, notificationsEnabled: Boolean(row.notificationsEnabled) });

export function lessonRows(db: SqliteDatabase, ownerId: number): Lesson[] {
  return (db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE owner_id=? ORDER BY weekday,start_time`).all(ownerId) as LessonRow[]).map(toLesson);
}

export function lessonById(db: SqliteDatabase, ownerId: number, id: number | bigint): Lesson | undefined {
  const row = db.prepare(`SELECT ${LESSON_COLUMNS} FROM lessons WHERE id=? AND owner_id=?`).get(id, ownerId) as LessonRow | undefined;
  return row && toLesson(row);
}

export function addNotification(db: SqliteDatabase, ownerId: number, kind: "reminder" | "system", title: string, body: string) {
  db.prepare("INSERT INTO notifications (owner_id, kind, title, body) VALUES (?,?,?,?)").run(ownerId, kind, title, body);
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
