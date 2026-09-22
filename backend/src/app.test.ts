import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase, seedLegalHolidays, setNonWorkingDay } from "./db.js";
import { deriveWebhookSecret } from "./telegram.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
let server: Server;
let base = "";

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const config = loadConfig({ ALLOW_DEV_AUTH: "true", TELEGRAM_BOT_TOKEN: TOKEN, RATE_LIMIT_PER_MINUTE: "60" });
  const app = createApp({ db: openDatabase(":memory:"), config, log: { error: () => undefined, warn: () => undefined } });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const api = (path: string, init: RequestInit = {}, user = "1001") => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(user ? { "x-dev-telegram-id": user } : {}), ...init.headers } });
const UUID = "0b6e3f8e-1111-4111-8111-111111111111";
/** Every Teacher Catalog route, to check that the Profesor mode rule is mounted on all of them. */
const TEACHER_ROUTES = [
  ["GET", "/api/teacher/groups"], ["POST", "/api/teacher/groups"],
  ["PATCH", `/api/teacher/groups/${UUID}`], ["DELETE", `/api/teacher/groups/${UUID}`],
  ["GET", `/api/teacher/groups/${UUID}/students`], ["POST", `/api/teacher/groups/${UUID}/students`],
  ["PATCH", `/api/teacher/students/${UUID}`], ["DELETE", `/api/teacher/students/${UUID}`],
  ["GET", `/api/teacher/groups/${UUID}/attendance`], ["POST", `/api/teacher/groups/${UUID}/attendance`],
  ["GET", `/api/teacher/students/${UUID}/grades`], ["POST", `/api/teacher/students/${UUID}/grades`]
];
const lesson = { role: "student", title: "Fizică", groupName: null, teacherName: null, room: null, weekday: 1, startTime: "08:00", endTime: "09:30", weekKind: "every", reminderMinutes: 15, notificationsEnabled: true };

describe("HTTP API", () => {
  it("serves health without authentication", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ok", sqlite: "ok", postgres: "disabled" });
  });

  it("rejects unauthenticated and forged requests", async () => {
    expect((await api("/api/me", {}, "")).status).toBe(401);
    expect((await api("/api/me", { headers: { "x-telegram-init-data": "user=%7B%22id%22%3A1%7D&auth_date=1&hash=00" } }, "")).status).toBe(401);
    expect((await api("/api/me", {}, "-5")).status).toBe(401);
  });

  it("returns booleans in the profile", async () => {
    const me = await (await api("/api/me")).json();
    expect(me.profile).toMatchObject({ telegramId: 1001, role: "student", studentEnabled: true, teacherEnabled: true });
    const patched = await (await api("/api/me", { method: "PATCH", body: JSON.stringify({ teacherEnabled: false }) })).json();
    expect(patched.teacherEnabled).toBe(false);
  });

  it("creates, updates and deletes lessons only for their owner", async () => {
    const created = await api("/api/lessons", { method: "POST", body: JSON.stringify(lesson) });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await api(`/api/lessons/${id}`, { method: "PUT", body: JSON.stringify({ ...lesson, title: "Hack" }) }, "2002")).status).toBe(404);
    expect((await api(`/api/lessons/${id}`, { method: "DELETE" }, "2002")).status).toBe(404);
    expect(await (await api("/api/lessons", {}, "2002")).json()).toEqual([]);
    const updated = await api(`/api/lessons/${id}`, { method: "PUT", body: JSON.stringify({ ...lesson, title: "Fizică II" }) });
    expect(await updated.json()).toMatchObject({ id, title: "Fizică II", notificationsEnabled: true });
    expect((await api(`/api/lessons/${id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("returns 400 for invalid input and malformed JSON instead of 500", async () => {
    const invalid = await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, endTime: "07:00" }) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).fields[0].path).toBe("endTime");
    expect((await api("/api/lessons", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await api("/api/lessons/abc", { method: "DELETE" })).status).toBe(400);
    expect((await api("/api/week?date=2026-02-30")).status).toBe(400);
    expect(await (await api("/api/week?date=2026-09-10")).json()).toMatchObject({ number: 1, kind: "even" });
    expect((await api("/api/nope")).status).toBe(404);
  });

  it("keeps the Student and Profesor schedules of one user separate", async () => {
    const user = "4004";
    const post = async (body: object) => {
      const response = await api("/api/lessons", { method: "POST", body: JSON.stringify(body) }, user);
      expect(response.status).toBe(201);
      return response.json();
    };
    const student = await post({ ...lesson, title: "Analiză", startTime: "08:00", endTime: "09:30" });
    const teacher = await post({ ...lesson, role: "teacher", title: "Rețele", groupName: "SI-265", startTime: "09:30", endTime: "11:00" });
    expect(student.role).toBe("student");
    expect(teacher.role).toBe("teacher");

    const titles = async (query: string, as = user) => (await (await api(`/api/lessons${query}`, {}, as)).json()).map((item: { title: string }) => item.title);
    expect(await titles("?role=student")).toEqual(["Analiză"]);
    expect(await titles("?role=teacher")).toEqual(["Rețele"]);
    expect(await titles("")).toEqual(["Analiză", "Rețele"]);
    expect(await titles("?role=student", "5005")).toEqual([]);
    expect((await api("/api/lessons?role=admin", {}, user)).status).toBe(400);

    // Switching the active profile role changes nothing in the stored lessons.
    expect((await api("/api/me", { method: "PATCH", body: JSON.stringify({ role: "teacher" }) }, user)).status).toBe(200);
    expect(await titles("?role=student")).toEqual(["Analiză"]);

    // PUT without a role keeps the lesson in its schedule; the role changes only when sent explicitly.
    const { role: _omit, ...withoutRole } = { ...lesson, title: "Analiză II" };
    const kept = await (await api(`/api/lessons/${student.id}`, { method: "PUT", body: JSON.stringify(withoutRole) }, user)).json();
    expect(kept).toMatchObject({ id: student.id, role: "student", title: "Analiză II" });
    const same = await (await api(`/api/lessons/${teacher.id}`, { method: "PUT", body: JSON.stringify({ ...lesson, role: "teacher", title: "Rețele II" }) }, user)).json();
    expect(same).toMatchObject({ id: teacher.id, role: "teacher" });
    const moved = await (await api(`/api/lessons/${student.id}`, { method: "PUT", body: JSON.stringify({ ...lesson, role: "teacher" }) }, user)).json();
    expect(moved.role).toBe("teacher");
    expect(await titles("?role=student")).toEqual([]);
    expect((await api(`/api/lessons/${student.id}`, { method: "PUT", body: JSON.stringify({ ...lesson, role: "admin" }) }, user)).status).toBe(400);
  });

  it("normalises time formats from mobile time inputs and explains invalid fields in Romanian", async () => {
    const user = "6006";
    const created = await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, startTime: "9:30", endTime: "10:45:00" }) }, user);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ startTime: "09:30", endTime: "10:45" });
    // "9:30" < "10:00" only after zero padding; unpadded strings would compare the wrong way.
    expect((await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, startTime: "9:30", endTime: "10:00" }) }, user)).status).toBe(201);

    const invalid = await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, title: "x".repeat(121), weekday: 8, startTime: "25:00", reminderMinutes: 500, groupName: "" }) }, user);
    expect(invalid.status).toBe(400);
    const { fields } = await invalid.json() as { fields: Array<{ path: string, message: string }> };
    expect(Object.fromEntries(fields.map((field) => [field.path, field.message]))).toEqual({
      title: "Maximum 120 caractere", weekday: "Ziua trebuie să fie între 1 și 7", startTime: "Ora trebuie să fie în format HH:MM",
      reminderMinutes: "Memento-ul poate fi între 0 și 180 de minute"
    });
    const missingRole = await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, role: undefined }) }, user);
    expect((await missingRole.json()).fields[0]).toEqual({ path: "role", message: "Rolul trebuie să fie student sau profesor" });
  });

  it("ties lesson notifications to their schedule and marks them read per role", async () => {
    const user = "7007";
    await api("/api/lessons", { method: "POST", body: JSON.stringify(lesson) }, user);
    await api("/api/lessons", { method: "POST", body: JSON.stringify({ ...lesson, role: "teacher" }) }, user);
    type Row = { role: string | null, readAt: string | null, body: string };
    const rows = async () => (await (await api("/api/notifications", {}, user)).json()) as Row[];
    expect((await rows()).map((row) => row.role).sort()).toEqual(["student", "teacher"]);
    expect((await rows()).find((row) => row.role === "teacher")?.body).toContain("orarul de Profesor");
    expect((await api("/api/notifications/read", { method: "PATCH", body: JSON.stringify({ role: "student" }) }, user)).status).toBe(204);
    expect((await rows()).map((row) => [row.role, Boolean(row.readAt)]).sort()).toEqual([["student", true], ["teacher", false]]);
    expect((await api("/api/notifications/read", { method: "PATCH" }, user)).status).toBe(204);
    expect((await rows()).every((row) => row.readAt)).toBe(true);
  });

  it("reports the teacher catalog as unavailable without PostgreSQL", async () => {
    // A user with the Profesor mode still enabled (1001 disabled it above).
    expect((await api("/api/teacher/groups", {}, "9101")).status).toBe(503);
  });

  it("refuses every Teacher Catalog route when the Profesor mode is off", async () => {
    const off = "9102", on = "9103";
    expect((await api("/api/me", { method: "PATCH", body: JSON.stringify({ teacherEnabled: false }) }, off)).status).toBe(200);
    for (const [method, path] of TEACHER_ROUTES) {
      const denied = await api(path, { method }, off);
      expect([method, path, denied.status]).toEqual([method, path, 403]);
      expect((await denied.json()).error).toMatch(/modul Profesor/i);
      // The same route with the mode enabled gets past the rule (503/400 without PostgreSQL).
      expect([method, path, (await api(path, { method }, on)).status]).not.toEqual([method, path, 403]);
    }
  });

  it("rejects grade feedback with control characters with 400, not 500", async () => {
    const response = await api(`/api/teacher/students/${UUID}/grades`, { method: "POST", body: JSON.stringify({ laboratory: "Lab 1", grade: 9, feedback: "bine " }) }, "9103");
    expect(response.status).toBe(400);
    expect((await response.json()).fields[0].path).toBe("feedback");
  });

  it("protects the Telegram webhook with the secret token", async () => {
    const body = JSON.stringify({ update_id: 1, message: { text: "/rol profesor", chat: { id: 1001, type: "private" }, from: { id: 1001, first_name: "X" } } });
    expect((await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
    expect((await fetch(`${base}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" }, body })).status).toBe(401);
    expect(deriveWebhookSecret(TOKEN)).toHaveLength(64);
  });

  it("rate limits a user", async () => {
    let last = 0;
    for (let i = 0; i < 65; i += 1) last = (await api("/api/notifications", {}, "3003")).status;
    expect(last).toBe(429);
  });
});

describe("public health endpoint", () => {
  // Runs last: /health and /api/health share one IP limiter for the whole window.
  it("is rate limited per IP even though it skips the /api limiter", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const response = await fetch(`${base}/api/health`);
      await response.text();
      statuses.push(response.status);
    }
    expect(statuses).toContain(200);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("HTTP API profile rules", () => {
  const patch = async (body: object, user: string) => {
    const response = await api("/api/me", { method: "PATCH", body: JSON.stringify(body) }, user);
    return { status: response.status, body: await response.json() };
  };

  it("keeps at least one mode enabled and the active role an enabled mode", async () => {
    const user = "8008";
    expect((await patch({ teacherEnabled: false }, user)).body).toMatchObject({ role: "student", studentEnabled: true, teacherEnabled: false });
    // Selecting a disabled mode is refused and nothing changes.
    expect(await patch({ role: "teacher" }, user)).toEqual({ status: 409, body: { error: "Modul Profesor este dezactivat. Activează-l mai întâi." } });
    expect(await patch({ studentEnabled: false }, user)).toEqual({ status: 409, body: { error: "Cel puțin un mod trebuie să rămână activ." } });
    expect(await patch({ role: "student", studentEnabled: false, teacherEnabled: true }, user)).toEqual({ status: 409, body: { error: "Modul Student este dezactivat. Activează-l mai întâi." } });
    expect((await (await api("/api/me", {}, user)).json()).profile).toMatchObject({ role: "student", studentEnabled: true, teacherEnabled: false });
    // Enabling and selecting in one request is allowed.
    expect(await patch({ role: "teacher", teacherEnabled: true }, user)).toMatchObject({ status: 200, body: { role: "teacher", teacherEnabled: true } });
  });

  it("switches the active role when its mode is disabled while the other is enabled", async () => {
    const user = "8009";
    expect(await patch({ role: "teacher" }, user)).toMatchObject({ status: 200, body: { role: "teacher" } });
    expect(await patch({ teacherEnabled: false }, user)).toMatchObject({ status: 200, body: { role: "student", studentEnabled: true, teacherEnabled: false } });
    expect(await patch({ teacherEnabled: true, studentEnabled: false }, user)).toMatchObject({ status: 200, body: { role: "teacher", studentEnabled: false, teacherEnabled: true } });
  });

  it("exposes and updates remindersEnabled", async () => {
    const user = "8010";
    expect((await (await api("/api/me", {}, user)).json()).profile.remindersEnabled).toBe(true);
    expect(await patch({ remindersEnabled: false }, user)).toMatchObject({ status: 200, body: { remindersEnabled: false, role: "student" } });
    expect((await (await api("/api/me", {}, user)).json()).profile.remindersEnabled).toBe(false);
    expect((await patch({ remindersEnabled: "no" }, user)).status).toBe(400);
  });
});

describe("GET /api/week", () => {
  let weekServer: Server;
  let weekBase = "";
  const week = (query = "") => fetch(`${weekBase}/api/week${query}`, { headers: { "x-dev-telegram-id": "7007" } });

  beforeAll(async () => {
    const db = openDatabase(":memory:");
    // Seeded explicitly: openDatabase only seeds the current year and the next one, and this test
    // asserts the holidays of January 2027 whatever year it is run in.
    seedLegalHolidays(db, 2027);
    // A custom free day inside the week of 2027-01-15 (Monday 2027-01-11 → Sunday 2027-01-17), which
    // contains no legal holiday: the answer must show it although the date asked is not a holiday itself.
    setNonWorkingDay(db, "2027-01-15", "Vacanță de iarnă");
    const config = loadConfig({ ALLOW_DEV_AUTH: "true", TELEGRAM_BOT_TOKEN: TOKEN, RATE_LIMIT_PER_MINUTE: "60", SEMESTERS: "2026-09-07:even:2026-12-20" });
    weekServer = createApp({ db, config, log: { error: () => undefined, warn: () => undefined } }).listen(0, "127.0.0.1");
    await new Promise((resolve) => weekServer.once("listening", resolve));
    weekBase = `http://127.0.0.1:${(weekServer.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => weekServer.close(() => resolve())));

  it("answers with the week, the semesters and the free days of that week", async () => {
    const response = await week("?date=2027-01-15");
    expect(response.status).toBe(200);
    // The full contract the Mini App aligns to: 2027-01-15 is outside every semester (winter break),
    // yet the week still has a number and a parity, counted from the semester that already started.
    expect(await response.json()).toEqual({
      date: "2027-01-15", number: 19, kind: "even",
      inSemester: false, semesterStart: "2026-09-07", semesterEnd: "2026-12-20",
      semesters: [{ start: "2026-09-07", kind: "even", end: "2026-12-20" }],
      nonWorkingDays: [{ date: "2027-01-15", label: "Vacanță de iarnă" }],
      referenceMonday: "2026-09-07", referenceKind: "even"
    });
  });

  it("marks a date inside the semester and leaves a free week empty", async () => {
    // Week 1 of the semester: teaching days, and no public holiday between 7 and 13 September.
    expect(await (await week("?date=2026-09-09")).json()).toMatchObject({ date: "2026-09-09", number: 1, kind: "even", inSemester: true, nonWorkingDays: [] });
    expect(await (await week("?date=2026-09-16")).json()).toMatchObject({ number: 2, kind: "odd", inSemester: true });
  });

  it("falls back to today and still rejects a malformed date", async () => {
    const today = await (await week()).json();
    expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(today.semesters)).toBe(true);
    expect(await (await week("?date=2027-02-30")).json()).toEqual({ error: "Data trebuie să fie în format YYYY-MM-DD" });
    expect((await week("?date=15.01.2027")).status).toBe(400);
    expect((await fetch(`${weekBase}/api/week`)).status).toBe(401);
  });

  it("lists the free days of an interval and validates it", async () => {
    const days = await (await fetch(`${weekBase}/api/non-working-days?from=2027-01-01&to=2027-01-31`, { headers: { "x-dev-telegram-id": "7007" } })).json();
    // Seeded legal holidays of January plus the day added above.
    expect(days).toEqual([
      { date: "2027-01-01", label: "Anul Nou" }, { date: "2027-01-07", label: "Crăciunul pe stil vechi" },
      { date: "2027-01-08", label: "Crăciunul pe stil vechi" }, { date: "2027-01-15", label: "Vacanță de iarnă" }
    ]);
    const bad = (query: string) => fetch(`${weekBase}/api/non-working-days${query}`, { headers: { "x-dev-telegram-id": "7007" } });
    expect((await bad("?from=2027-01-31&to=2027-01-01")).status).toBe(400);
    expect((await bad("?from=2027-01-01&to=2030-01-01")).status).toBe(400);
    expect((await bad("?from=2027-01-01")).status).toBe(400);
    expect((await fetch(`${weekBase}/api/non-working-days?from=2027-01-01&to=2027-01-31`)).status).toBe(401);
  });

  it("registers no route that writes free days", async () => {
    // Institution-wide data with no administrator model: writing is a server-side operation.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${weekBase}/api/non-working-days`, { method, headers: { "content-type": "application/json", "x-dev-telegram-id": "7007" }, body: JSON.stringify({ date: "2027-03-02", label: "Zi liberă" }) });
      expect(response.status).toBe(404);
    }
  });
});
