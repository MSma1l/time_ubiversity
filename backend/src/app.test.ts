import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
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
    expect((await api("/api/teacher/groups")).status).toBe(503);
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
