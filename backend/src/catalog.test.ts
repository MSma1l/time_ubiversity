import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { academicDatabase, closeAcademicDatabase, ensureAcademicSchema, isConnectionError } from "./academic.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { attendanceSchema, catalogDateSchema, gradeSchema, groupPatchSchema, studentPatchSchema } from "./validation.js";

describe("catalog validation", () => {
  it("accepts only dates PostgreSQL can store, in years 2000–2100", () => {
    expect(catalogDateSchema.safeParse("2026-09-14").success).toBe(true);
    expect(catalogDateSchema.safeParse("0000-01-01").success).toBe(false);
    expect(catalogDateSchema.safeParse("1999-12-31").success).toBe(false);
    expect(catalogDateSchema.safeParse("2101-01-01").success).toBe(false);
    expect(attendanceSchema.safeParse({ date: "0000-05-05", entries: [] }).success).toBe(false);
    expect(gradeSchema.safeParse({ laboratory: "Lab 1", grade: 9, presentedOn: "0000-01-01" }).success).toBe(false);
  });

  it("requires at least one change for group and student patches", () => {
    expect(groupPatchSchema.safeParse({}).success).toBe(false);
    expect(groupPatchSchema.parse({ subject: "" })).toEqual({ subject: null });
    expect(groupPatchSchema.safeParse({ name: "S" }).success).toBe(false);
    expect(studentPatchSchema.safeParse({}).success).toBe(false);
    expect(studentPatchSchema.parse({ lastName: " Rusu " })).toEqual({ lastName: "Rusu" });
  });

  it("recognises PostgreSQL connection errors", () => {
    expect(isConnectionError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("connection failure"), { code: "08006" }))).toBe(true);
    expect(isConnectionError(Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ETIMEDOUT" })]), {}))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isConnectionError(Object.assign(new Error("date/time field value out of range"), { code: "22008" }))).toBe(false);
  });
});

/**
 * Integration tests need a THROWAWAY PostgreSQL database (tables are dropped):
 * DATABASE_URL_TEST=postgres://postgres:postgres@127.0.0.1:55599/postgres npm test
 */
const databaseUrl = process.env.DATABASE_URL_TEST?.trim() ?? "";

describe.skipIf(!databaseUrl)("Teacher Catalog API (PostgreSQL)", () => {
  let server: Server;
  let base = "";
  const warnings: string[] = [];

  const api = async (path: string, init: RequestInit = {}, user = "1001") => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", "x-dev-telegram-id": user, ...init.headers } });
    const body = response.status === 204 ? undefined : await response.json();
    return { status: response.status, body };
  };
  const post = (path: string, body: unknown, user?: string) => api(path, { method: "POST", body: JSON.stringify(body) }, user);
  const patch = (path: string, body: unknown, user?: string) => api(path, { method: "PATCH", body: JSON.stringify(body) }, user);
  const remove = (path: string, user?: string) => api(path, { method: "DELETE" }, user);

  beforeAll(async () => {
    // Legacy schema with data the migrations must repair: duplicate grades and case-only duplicate group names.
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("DROP TABLE IF EXISTS lab_grades, attendance_entries, attendance_sessions, students, academic_groups CASCADE");
    await client.query(`CREATE TABLE academic_groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id BIGINT NOT NULL, name VARCHAR(80) NOT NULL, subject VARCHAR(120), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id,name));
      CREATE TABLE students (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES academic_groups(id) ON DELETE CASCADE, first_name VARCHAR(80) NOT NULL, last_name VARCHAR(80) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE lab_grades (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE, laboratory VARCHAR(120) NOT NULL, presented_on DATE, grade NUMERIC(4,2) NOT NULL CHECK(grade >= 0 AND grade <= 10), feedback VARCHAR(500), created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    const legacy = await client.query("INSERT INTO academic_groups(owner_id,name) VALUES(9009,'si-265'),(9009,'SI-265') RETURNING id");
    const student = await client.query("INSERT INTO students(group_id,first_name,last_name) VALUES($1,'Ana','Rusu') RETURNING id", [legacy.rows[0].id]);
    await client.query("INSERT INTO lab_grades(student_id,laboratory,grade,created_at) VALUES($1,'Lab 1',5,now()-interval '2 hours'),($1,'Lab 1',7,now()-interval '1 hour'),($1,'Lab 2',9,now())", [student.rows[0].id]);
    await client.end();

    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
    const config = loadConfig({ ALLOW_DEV_AUTH: "true", RATE_LIMIT_PER_MINUTE: "1000", DATABASE_URL: databaseUrl });
    const app = createApp({ db: openDatabase(":memory:"), config, log: { error: () => undefined, warn: () => undefined } });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeAcademicDatabase();
  });

  const indexes = async () => (await academicDatabase(databaseUrl)!.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('lab_grades','academic_groups')")).rows.map((row) => row.indexname as string);

  it("migrates legacy data: keeps the latest grade and never fails on case-only duplicate groups", async () => {
    expect(await ensureAcademicSchema(databaseUrl)).toBe(true);
    const pool = academicDatabase(databaseUrl)!;
    const grades = await pool.query("SELECT laboratory, grade::float8 AS grade FROM lab_grades ORDER BY laboratory");
    expect(grades.rows).toEqual([{ laboratory: "Lab 1", grade: 7 }, { laboratory: "Lab 2", grade: 9 }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM academic_groups WHERE owner_id=9009")).rows[0].count).toBe(2);
    expect(await indexes()).toContain("lab_grades_student_lab_uidx");
    expect(await indexes()).not.toContain("academic_groups_owner_lower_name_uidx");
    expect(warnings.some((line) => line.includes("letter case"))).toBe(true);

    // Once the duplicate is removed, the next initialisation creates the case-insensitive index.
    const groups = await api("/api/teacher/groups", {}, "9009");
    expect(groups.body.map((group: { name: string }) => group.name).sort()).toEqual(["SI-265", "si-265"]);
    expect((await remove(`/api/teacher/groups/${groups.body[1].id}`, "9009")).status).toBe(204);
    await closeAcademicDatabase();
    await ensureAcademicSchema(databaseUrl);
    expect(await indexes()).toContain("academic_groups_owner_lower_name_uidx");
  });

  let groupId = "";
  let anaId = "";
  let ionId = "";

  it("creates groups with case-insensitive unique names per owner", async () => {
    const created = await post("/api/teacher/groups", { name: "si-265", subject: "Web" });
    expect(created.status).toBe(201);
    groupId = created.body.id;
    const duplicate = await post("/api/teacher/groups", { name: "SI-265" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toMatch(/Ai deja o grupă/);
    expect((await post("/api/teacher/groups", { name: "SI-265" }, "2002")).status).toBe(201);
    const other = await post("/api/teacher/groups", { name: "TI-231" });
    expect((await patch(`/api/teacher/groups/${other.body.id}`, { name: "Si-265" })).status).toBe(409);
    const ana = await post(`/api/teacher/groups/${groupId}/students`, { firstName: "Ana", lastName: "Rusu" });
    const ion = await post(`/api/teacher/groups/${groupId}/students`, { firstName: "Ion", lastName: "Albu" });
    anaId = ana.body.id; ionId = ion.body.id;
    expect(anaId && ionId).toBeTruthy();
  });

  it("returns saved attendance for a date, scoped to the owner", async () => {
    const empty = await api(`/api/teacher/groups/${groupId}/attendance?date=2026-09-14`);
    expect(empty).toEqual({ status: 200, body: { date: "2026-09-14", sessionId: null, topic: null, entries: [] } });
    expect((await post(`/api/teacher/groups/${groupId}/attendance`, { date: "2026-09-14", entries: [{ studentId: anaId, status: "late" }] })).status).toBe(204);
    expect((await post(`/api/teacher/groups/${groupId}/attendance`, { date: "2026-09-14", entries: [{ studentId: ionId, status: "present" }] })).status).toBe(204);
    const saved = await api(`/api/teacher/groups/${groupId}/attendance?date=2026-09-14`);
    expect(saved.status).toBe(200);
    expect(saved.body.entries).toHaveLength(2);
    expect(saved.body.entries).toEqual(expect.arrayContaining([{ studentId: anaId, status: "late" }, { studentId: ionId, status: "present" }]));
    expect((await api(`/api/teacher/groups/${groupId}/attendance?date=2026-09-15`)).body.entries).toEqual([]);
    expect((await api(`/api/teacher/groups/${groupId}/attendance?date=2026-09-14`, {}, "2002")).status).toBe(404);
    expect((await api("/api/teacher/groups/not-a-uuid/attendance?date=2026-09-14")).status).toBe(404);
    expect((await api(`/api/teacher/groups/${groupId}/attendance?date=0000-01-01`)).status).toBe(400);
    expect((await api(`/api/teacher/groups/${groupId}/attendance`)).status).toBe(200);
  });

  it("upserts one grade per laboratory and lists grades only for the owner", async () => {
    const first = await post(`/api/teacher/students/${anaId}/grades`, { laboratory: "Lab 1", grade: 8.5, presentedOn: "2026-09-14" });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ laboratory: "Lab 1", grade: 8.5, presented_on: "2026-09-14" });
    const second = await post(`/api/teacher/students/${anaId}/grades`, { laboratory: "Lab 1", grade: 9.25 });
    expect(second.status).toBe(200);
    expect(second.body.grade).toBe(9.25);
    await post(`/api/teacher/students/${anaId}/grades`, { laboratory: "Lab 2", grade: 10 });
    const list = await api(`/api/teacher/students/${anaId}/grades`);
    expect(list.status).toBe(200);
    expect(list.body.map((grade: { laboratory: string, grade: number }) => [grade.laboratory, grade.grade])).toEqual([["Lab 1", 9.25], ["Lab 2", 10]]);
    expect((await api(`/api/teacher/students/${anaId}/grades`, {}, "2002")).status).toBe(404);
    expect((await post(`/api/teacher/students/${anaId}/grades`, { laboratory: "Lab 3", grade: 5 }, "2002")).status).toBe(404);
    expect((await api("/api/teacher/students/bad/grades")).status).toBe(404);
    expect((await post(`/api/teacher/students/${anaId}/grades`, { laboratory: "Lab 3", grade: 5, presentedOn: "0000-01-01" })).status).toBe(400);
  });

  it("renames and deletes students with ownership checks and cascade", async () => {
    expect((await patch(`/api/teacher/students/${ionId}`, { firstName: "Ioan" }, "2002")).status).toBe(404);
    const renamed = await patch(`/api/teacher/students/${ionId}`, { firstName: "Ioan" });
    expect(renamed).toMatchObject({ status: 200, body: { id: ionId, first_name: "Ioan", last_name: "Albu" } });
    expect((await remove(`/api/teacher/students/${anaId}`, "2002")).status).toBe(404);
    expect((await remove(`/api/teacher/students/${anaId}`)).status).toBe(204);
    expect((await remove(`/api/teacher/students/${anaId}`)).status).toBe(404);
    const pool = academicDatabase(databaseUrl)!;
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM lab_grades WHERE student_id=$1", [anaId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM attendance_entries WHERE student_id=$1", [anaId])).rows[0].count).toBe(0);
    const groups = await api("/api/teacher/groups");
    expect(groups.body.find((group: { id: string }) => group.id === groupId).student_count).toBe(1);
  });

  it("renames and deletes groups with ownership checks and cascade", async () => {
    expect((await patch(`/api/teacher/groups/${groupId}`, { name: "SI-265 PC" }, "2002")).status).toBe(404);
    const renamed = await patch(`/api/teacher/groups/${groupId}`, { name: "SI-265", subject: "" });
    expect(renamed).toMatchObject({ status: 200, body: { id: groupId, name: "SI-265", subject: null, student_count: 1 } });
    expect((await remove(`/api/teacher/groups/${groupId}`, "2002")).status).toBe(404);
    expect((await remove(`/api/teacher/groups/${groupId}`)).status).toBe(204);
    const pool = academicDatabase(databaseUrl)!;
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM students WHERE group_id=$1", [groupId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM attendance_sessions WHERE group_id=$1", [groupId])).rows[0].count).toBe(0);
    expect((await api(`/api/teacher/groups/${groupId}/students`)).status).toBe(404);
  });

  it("answers 503 when PostgreSQL drops after startup and re-initialises afterwards", async () => {
    const pool = academicDatabase(databaseUrl)!;
    const spy = vi.spyOn(pool, "query").mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }) as never);
    const down = await api("/api/teacher/groups");
    expect(down.status).toBe(503);
    expect(down.body.error).toMatch(/Catalogul Profesor/);
    expect((await (await fetch(`${base}/health`)).json()).postgres).toBe("connecting");
    spy.mockRestore();
    expect((await api("/api/teacher/groups")).status).toBe(200);
    expect((await (await fetch(`${base}/health`)).json()).postgres).toBe("ready");
  });
});
