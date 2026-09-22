import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { closeAcademicDatabase } from "./academic.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { collectGroupCandidates, computeLessonLinks, groupKey, isOwnerSynced, ownerLessonLinks, renameLessonGroup, teacherLessonGroups, withLessonLinks } from "./groupSync.js";

const lesson = (groupName: string | null, title: string) => ({ groupName, title });

describe("lesson ↔ catalog group matching", () => {
  it("normalises group names: trimmed and case-insensitive, empty means no group", () => {
    expect(groupKey("  IBM-261 ")).toBe("ibm-261");
    expect(groupKey("Sad-262")).toBe(groupKey("SAD-262"));
    expect(groupKey("   ")).toBe("");
    expect(groupKey(null)).toBe("");
    expect(groupKey(undefined)).toBe("");
  });

  it("collects distinct groups, keeping the first spelling and its lesson title as subject", () => {
    const candidates = collectGroupCandidates([
      lesson(" IBM-261 ", "PC"), lesson("R-261", "PC"), lesson("ibm-261", "TPA"), lesson("Sad-262", " TPA "),
      lesson(null, "Fără grupă"), lesson("   ", "Gol"), lesson("x".repeat(81), "Prea lung"), lesson("Bad\u0001", "Control")
    ]);
    expect(candidates).toEqual([{ name: "IBM-261", subject: "PC" }, { name: "R-261", subject: "PC" }, { name: "Sad-262", subject: "TPA" }]);
  });

  it("truncates the subject on code points, never inside a surrogate pair", () => {
    const [group] = collectGroupCandidates([lesson("IBM-261", `${"x".repeat(119)}\u{1F600} restul titlului`)]);
    expect([...group.subject!].length).toBe(120);
    expect(group.subject!.endsWith("\u{1F600}")).toBe(true);
    expect(group.subject).not.toMatch(/[\uD800-\uDFFF]/u); // no lone surrogate ("\uFFFD" in PostgreSQL)
  });

  it("computes linkedLessons and sorted distinct subjects per group", () => {
    const links = computeLessonLinks([lesson("IBM-261", "PC"), lesson(" ibm-261", "Baze de date"), lesson("IBM-261 ", "PC"), lesson("R-261", "PC"), lesson(null, "PC")]);
    expect(links.get("ibm-261")).toEqual({ linkedLessons: 3, subjects: ["Baze de date", "PC"] });
    expect(links.get("r-261")).toEqual({ linkedLessons: 1, subjects: ["PC"] });
    expect(withLessonLinks({ id: "g1", name: "Ibm-261", student_count: 2 }, links)).toEqual({ id: "g1", name: "Ibm-261", student_count: 2, linkedLessons: 3, subjects: ["Baze de date", "PC"] });
    expect(withLessonLinks({ name: "TI-231" }, links)).toEqual({ name: "TI-231", linkedLessons: 0, subjects: [] });
  });

  it("reads only the owner's teacher lessons from SQLite and has the sync table", () => {
    const db = openDatabase(":memory:");
    const insert = db.prepare("INSERT INTO lessons (owner_id,role,title,group_name,weekday,start_time,end_time) VALUES (?,?,?,?,1,'08:00','09:30')");
    insert.run(1, "teacher", "PC", "IBM-261");
    insert.run(1, "teacher", "TPA", "sad-262");
    insert.run(1, "student", "Fizică", "IBM-261");
    insert.run(1, "teacher", "Consultații", null);
    insert.run(2, "teacher", "PC", "IBM-261");
    expect(teacherLessonGroups(db, 1)).toEqual([lesson("IBM-261", "PC"), lesson("sad-262", "TPA")]);
    expect(ownerLessonLinks(db, 1).get("ibm-261")).toEqual({ linkedLessons: 1, subjects: ["PC"] });
    expect(isOwnerSynced(db, 1)).toBe(false);
    db.prepare("INSERT INTO catalog_group_sync(owner_id, synced_at) VALUES (1, 'now')").run();
    expect(isOwnerSynced(db, 1)).toBe(true);
    openDatabase(":memory:"); // migration is idempotent on a fresh database too
  });

  it("renames the group only in the owner's teacher lessons, matching like groupKey", () => {
    const db = openDatabase(":memory:");
    const insert = db.prepare("INSERT INTO lessons (owner_id,role,title,group_name,weekday,start_time,end_time) VALUES (?,?,?,?,1,'08:00','09:30')");
    insert.run(1, "teacher", "TPA", "Sad-262");
    insert.run(1, "teacher", "Laborator TPA", " sad-262 ");
    insert.run(1, "teacher", "PC", "IBM-261");
    insert.run(1, "student", "Fizică", "Sad-262");
    insert.run(2, "teacher", "TPA", "Sad-262");
    const names = (ownerId: number, role: string) =>
      (db.prepare("SELECT group_name AS groupName FROM lessons WHERE owner_id=? AND role=? ORDER BY id").all(ownerId, role) as Array<{ groupName: string | null }>).map((row) => row.groupName);

    expect(renameLessonGroup(db, 1, "SAD-262", "SAD-262 A")).toBe(2);
    expect(names(1, "teacher")).toEqual(["SAD-262 A", "SAD-262 A", "IBM-261"]);
    expect(names(1, "student")).toEqual(["Sad-262"]); // the Student schedule is never touched
    expect(names(2, "teacher")).toEqual(["Sad-262"]); // another owner is never touched
    expect(ownerLessonLinks(db, 1).get("sad-262 a")).toEqual({ linkedLessons: 2, subjects: ["Laborator TPA", "TPA"] });

    // A rename that only changes the letter case still rewrites the displayed text.
    expect(renameLessonGroup(db, 1, "sad-262 a", "Sad-262 A")).toBe(2);
    expect(names(1, "teacher")).toEqual(["Sad-262 A", "Sad-262 A", "IBM-261"]);
    // Nothing to rename: the same name again, an unknown group, an empty old or new name.
    expect(renameLessonGroup(db, 1, "Sad-262 A", " Sad-262 A ")).toBe(0);
    expect(renameLessonGroup(db, 1, "X-1", "X-2")).toBe(0);
    expect(renameLessonGroup(db, 1, "  ", "Y-1")).toBe(0);
    expect(renameLessonGroup(db, 1, "IBM-261", "  ")).toBe(0);
    expect(names(1, "teacher")).toEqual(["Sad-262 A", "Sad-262 A", "IBM-261"]);
  });
});

describe("lesson saves when PostgreSQL is unreachable", () => {
  let server: Server | undefined;
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await closeAcademicDatabase();
  });

  it("still saves teacher lessons (201/200) without waiting long or reporting an error", async () => {
    // Port 1 refuses connections immediately: the group sync fails and is only logged.
    const warnings: unknown[][] = [];
    const config = loadConfig({ ALLOW_DEV_AUTH: "true", RATE_LIMIT_PER_MINUTE: "1000", DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/postgres" });
    const app = createApp({ db: openDatabase(":memory:"), config, log: { error: () => undefined, warn: (...args: unknown[]) => { warnings.push(args); } } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = { role: "teacher", title: "PC", groupName: "IBM-261", teacherName: null, room: null, weekday: 1, startTime: "08:00", endTime: "09:30", weekKind: "every", reminderMinutes: 15, notificationsEnabled: true };
    const headers = { "content-type": "application/json", "x-dev-telegram-id": "3003" };
    const started = Date.now();
    const created = await fetch(`${base}/api/lessons`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const saved = await created.json();
    expect(saved).toMatchObject({ role: "teacher", groupName: "IBM-261" });
    const updated = await fetch(`${base}/api/lessons/${saved.id}`, { method: "PUT", headers, body: JSON.stringify({ ...body, groupName: "R-261" }) });
    expect(updated.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(warnings.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/api/teacher/groups`, { headers })).status).toBe(503);
  });
});
