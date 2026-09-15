import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lessonRows, openDatabase } from "./db.js";

const dirs: string[] = [];
function tempDatabasePath() {
  const dir = mkdtempSync(join(tmpdir(), "orar-db-"));
  dirs.push(dir);
  return join(dir, "orar.sqlite");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("openDatabase migrations", () => {
  it("opens a database created by the first Docker release and keeps every lesson in its schedule", () => {
    const path = tempDatabasePath();
    // Schema exactly as created by the original release (Orar-Univer-Docker.zip, backend/src/db.ts), before the
    // student_enabled / teacher_enabled columns were added to profiles.
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE profiles (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', timezone TEXT NOT NULL DEFAULT 'Europe/Chisinau');
      CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, role TEXT NOT NULL, title TEXT NOT NULL, group_name TEXT, teacher_name TEXT, room TEXT, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, week_kind TEXT NOT NULL DEFAULT 'every', reminder_minutes INTEGER NOT NULL DEFAULT 15, notifications_enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE delivered_reminders (lesson_id INTEGER NOT NULL, occurrence_key TEXT NOT NULL, PRIMARY KEY (lesson_id, occurrence_key));
      CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO profiles (telegram_id, display_name, role) VALUES (1, 'Ion', 'teacher');
      INSERT INTO lessons (owner_id, role, title, weekday, start_time, end_time, week_kind) VALUES (1, 'student', 'Fizică', 1, '08:00', '09:30', 'odd'), (1, 'teacher', 'Rețele', 2, '11:30', '13:00', 'every');
      INSERT INTO notifications (owner_id, kind, title, body) VALUES (1, 'system', 'Orar actualizat', 'Ai adăugat: Fizică');`);
    legacy.close();

    const db = openDatabase(path);
    expect(lessonRows(db, 1, "student").map((lesson) => lesson.title)).toEqual(["Fizică"]);
    expect(lessonRows(db, 1, "teacher").map((lesson) => lesson.title)).toEqual(["Rețele"]);
    expect(db.prepare("SELECT role, student_enabled AS s, teacher_enabled AS t FROM profiles").get()).toEqual({ role: "teacher", s: 1, t: 1 });
    expect(db.prepare("SELECT role FROM notifications").get()).toEqual({ role: null });
    db.close();
    // Re-opening an already migrated database is a no-op.
    expect(lessonRows(openDatabase(path), 1)).toHaveLength(2);
  });

  it("adds a missing role column and repairs invalid legacy values so the lessons stay visible", () => {
    const path = tempDatabasePath();
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE profiles (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL);
      CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, title TEXT NOT NULL, group_name TEXT, teacher_name TEXT, room TEXT, weekday INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL);
      CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO profiles VALUES (2, 'Ana');
      INSERT INTO lessons (owner_id, title, weekday, start_time, end_time) VALUES (2, 'Chimie', 3, '9:30', '11:00:00');`);
    legacy.close();

    const db = openDatabase(path);
    expect(lessonRows(db, 2, "student")).toMatchObject([{ title: "Chimie", role: "student", startTime: "09:30", endTime: "11:00", weekKind: "every", reminderMinutes: 15, notificationsEnabled: true }]);
    expect(db.prepare("SELECT role FROM profiles WHERE telegram_id=2").get()).toEqual({ role: "student" });

    db.prepare("UPDATE lessons SET role='Profesor', week_kind='both'").run();
    db.close();
    expect(lessonRows(openDatabase(path), 2)).toMatchObject([{ role: "teacher", weekKind: "every" }]);
  });

  it("repairs profiles that violate the mode rules and adds reminders_enabled", () => {
    const path = tempDatabasePath();
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE profiles (telegram_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', timezone TEXT NOT NULL DEFAULT 'Europe/Chisinau', student_enabled INTEGER NOT NULL DEFAULT 1, teacher_enabled INTEGER NOT NULL DEFAULT 1);
      INSERT INTO profiles (telegram_id, display_name, role, student_enabled, teacher_enabled) VALUES
        (1, 'Both off', 'teacher', 0, 0), (2, 'Teacher off', 'teacher', 1, 0), (3, 'Student off', 'student', 0, 1), (4, 'Valid', 'teacher', 0, 1);`);
    legacy.close();

    const db = openDatabase(path);
    expect(db.prepare("SELECT telegram_id AS id, role, student_enabled AS s, teacher_enabled AS t, reminders_enabled AS r FROM profiles ORDER BY telegram_id").all()).toEqual([
      { id: 1, role: "student", s: 1, t: 0, r: 1 },
      { id: 2, role: "student", s: 1, t: 0, r: 1 },
      { id: 3, role: "teacher", s: 0, t: 1, r: 1 },
      { id: 4, role: "teacher", s: 0, t: 1, r: 1 }
    ]);
    db.close();
  });
});
