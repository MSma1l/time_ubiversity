import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Pool } from "pg";
import { ZodError } from "zod";
import { academicDatabase, academicHealth, ensureAcademicSchema, isConnectionError, resetAcademicSchema } from "./academic.js";
import { handleBotMessage, webhookSecret } from "./bot.js";
import type { AppConfig } from "./config.js";
import { addNotification, lessonById, lessonRows, upsertProfile, type SqliteDatabase } from "./db.js";
import { ProfileRuleError, readProfile, updateProfile } from "./profile.js";
import { createRateLimiter, rateLimitMiddleware } from "./rateLimit.js";
import { isoDateInChisinau, isValidIsoDate, SEMESTER_REFERENCE_KIND, SEMESTER_REFERENCE_MONDAY, universityWeekKind, universityWeekNumber } from "./schedule.js";
import { safeEqual, validateInitData, type TelegramUser } from "./telegram.js";
import { attendanceQuerySchema, attendanceSchema, gradeSchema, groupPatchSchema, groupSchema, lessonIdSchema, lessonSchema, lessonUpdateSchema, notificationsReadSchema, profilePatchSchema, studentPatchSchema, studentSchema, uuidSchema } from "./validation.js";

export const LIMITS = { lessonsPerUser: 500, groupsPerTeacher: 200, studentsPerGroup: 500 };

type AuthRequest = Request & { telegramUser: TelegramUser };
const userOf = (req: Request) => (req as AuthRequest).telegramUser;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const GROUP_NOT_FOUND = "Grupa nu a fost găsită";
const STUDENT_NOT_FOUND = "Studentul nu a fost găsit";
const CATALOG_UNAVAILABLE = "Catalogul Profesor nu se poate conecta încă la PostgreSQL. Așteaptă câteva secunde și reîncearcă.";
const groupExists = (name: string) => `Ai deja o grupă cu numele „${name}” (literele mari și mici nu contează).`;

export type AppDependencies = { db: SqliteDatabase, config: AppConfig, log?: Pick<Console, "error" | "warn"> };

export function createApp({ db, config, log = console }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet({ crossOriginResourcePolicy: false }));

  const health = async (_req: Request, res: Response) => {
    let sqlite: "ok" | "error" = "ok";
    try { db.prepare("SELECT 1").get(); } catch { sqlite = "error"; }
    const postgres = (await academicHealth(config.databaseUrl)).status;
    const ok = sqlite === "ok";
    const status = !ok ? "error" : postgres === "ready" || postgres === "disabled" ? "ok" : "degraded";
    res.setHeader("Cache-Control", "no-store");
    // Only SQLite (the schedule) is critical; PostgreSQL powers the optional Teacher Catalog.
    res.status(ok ? 200 : 503).json({ ok, status, sqlite, postgres });
  };
  app.get("/health", health);
  app.get("/api/health", health);

  const ipLimiter = createRateLimiter(config.rateLimitPerMinute * 5);
  const userLimiter = createRateLimiter(config.rateLimitPerMinute);
  setInterval(() => { ipLimiter.prune(); userLimiter.prune(); }, 60_000).unref();

  const devHeaders = config.allowDevAuth ? ["X-Dev-Telegram-Id"] : [];
  app.use("/api", cors({
    origin: config.origins.length ? config.origins : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-Telegram-Init-Data", ...devHeaders],
    maxAge: 600
  }));
  app.use("/api", rateLimitMiddleware(ipLimiter, (req) => `ip:${req.ip ?? "unknown"}`));
  app.use(express.json({ limit: "64kb" }));

  function auth(req: Request, res: Response, next: NextFunction) {
    const initData = req.header("x-telegram-init-data") ?? "";
    let user = validateInitData(initData, config.token, config.initDataMaxAgeSeconds);
    if (!user && config.allowDevAuth && req.header("x-dev-telegram-id")) {
      const id = Number(req.header("x-dev-telegram-id"));
      if (Number.isSafeInteger(id) && id > 0) user = { id, first_name: "Developer" };
    }
    if (!user) return res.status(401).json({ error: "Telegram authentication failed. Reopen the Mini App." });
    const retryAfter = userLimiter.hit(`user:${user.id}`);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Prea multe cereri. Încearcă din nou peste câteva secunde." });
    }
    (req as AuthRequest).telegramUser = user;
    upsertProfile(db, user);
    next();
  }

  const profileOf = (id: number) => readProfile(db, id);

  app.get("/api/me", auth, (req, res) => {
    const user = userOf(req);
    res.json({ profile: profileOf(user.id), telegram: { id: user.id, firstName: user.first_name, username: user.username } });
  });
  app.patch("/api/me", auth, (req, res) => {
    const body = profilePatchSchema.parse(req.body);
    // Mode rules (profile.ts) are checked on the merged profile inside one transaction.
    try {
      res.json(updateProfile(db, userOf(req).id, body));
    } catch (error) {
      if (error instanceof ProfileRuleError) return res.status(409).json({ error: error.message });
      throw error;
    }
  });
  app.get("/api/week", auth, (req, res) => {
    const date = req.query.date;
    if (date !== undefined && !isValidIsoDate(date)) return res.status(400).json({ error: "Data trebuie să fie în format YYYY-MM-DD" });
    const requested = date ?? isoDateInChisinau();
    res.json({ date: requested, number: universityWeekNumber(requested), kind: universityWeekKind(requested), referenceMonday: SEMESTER_REFERENCE_MONDAY, referenceKind: SEMESTER_REFERENCE_KIND });
  });

  const roleLabel = (role: string) => role === "teacher" ? "Profesor" : "Student";

  // Student and Profesor schedules are two separate lists of the same user, told apart by `role`.
  app.get("/api/lessons", auth, (req, res) => {
    const role = req.query.role;
    if (role !== undefined && role !== "student" && role !== "teacher") return res.status(400).json({ error: "Rolul trebuie să fie student sau teacher" });
    res.json(lessonRows(db, userOf(req).id, role));
  });
  app.post("/api/lessons", auth, (req, res) => {
    const input = lessonSchema.parse(req.body); const ownerId = userOf(req).id;
    const count = (db.prepare("SELECT COUNT(*) AS count FROM lessons WHERE owner_id=?").get(ownerId) as { count: number }).count;
    if (count >= LIMITS.lessonsPerUser) throw new HttpError(409, `Ai atins limita de ${LIMITS.lessonsPerUser} ore în orar.`);
    const created = db.transaction(() => {
      const result = db.prepare(`INSERT INTO lessons (owner_id,role,title,group_name,teacher_name,room,weekday,start_time,end_time,week_kind,reminder_minutes,notifications_enabled) VALUES (@ownerId,@role,@title,@groupName,@teacherName,@room,@weekday,@startTime,@endTime,@weekKind,@reminderMinutes,@notificationsEnabled)`)
        .run({ ...input, ownerId, notificationsEnabled: Number(input.notificationsEnabled) });
      addNotification(db, ownerId, "system", "Orar actualizat", `Ai adăugat în orarul de ${roleLabel(input.role)}: ${input.title}, ${input.startTime}–${input.endTime}.`, input.role);
      return lessonById(db, ownerId, result.lastInsertRowid);
    })();
    res.status(201).json(created);
  });
  app.put("/api/lessons/:id", auth, (req, res) => {
    const id = lessonIdSchema.parse(req.params.id); const input = lessonUpdateSchema.parse(req.body); const ownerId = userOf(req).id;
    // A missing role keeps the lesson in the schedule it already belongs to.
    const result = db.prepare(`UPDATE lessons SET role=COALESCE(@role, role),title=@title,group_name=@groupName,teacher_name=@teacherName,room=@room,weekday=@weekday,start_time=@startTime,end_time=@endTime,week_kind=@weekKind,reminder_minutes=@reminderMinutes,notifications_enabled=@notificationsEnabled,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND owner_id=@ownerId`)
      .run({ ...input, role: input.role ?? null, id, ownerId, notificationsEnabled: Number(input.notificationsEnabled) });
    if (!result.changes) return res.status(404).json({ error: "Ora nu a fost găsită" });
    res.json(lessonById(db, ownerId, id));
  });
  app.delete("/api/lessons/:id", auth, (req, res) => {
    const id = lessonIdSchema.parse(req.params.id); const ownerId = userOf(req).id;
    const result = db.transaction(() => {
      db.prepare("DELETE FROM delivered_reminders WHERE lesson_id=? AND lesson_id IN (SELECT id FROM lessons WHERE owner_id=?)").run(id, ownerId);
      return db.prepare("DELETE FROM lessons WHERE id=? AND owner_id=?").run(id, ownerId);
    })();
    if (!result.changes) return res.status(404).json({ error: "Ora nu a fost găsită" });
    res.status(204).end();
  });

  app.get("/api/notifications", auth, (req, res) => {
    const rows = db.prepare("SELECT id, kind, title, body, role, read_at AS readAt, created_at AS createdAt FROM notifications WHERE owner_id=? ORDER BY id DESC LIMIT 50").all(userOf(req).id);
    res.json(rows);
  });
  /** Marks notifications as read; with `{ role }` only that schedule's notifications (and general ones). */
  app.patch("/api/notifications/read", auth, (req, res) => {
    const role = notificationsReadSchema.parse(req.body)?.role;
    if (role) db.prepare("UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE owner_id=? AND read_at IS NULL AND (role IS NULL OR role=?)").run(userOf(req).id, role);
    else db.prepare("UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE owner_id=? AND read_at IS NULL").run(userOf(req).id);
    res.status(204).end();
  });

  // ---- Teacher Catalog (PostgreSQL). Every query is scoped to the authenticated owner. ----
  async function catalog(res: Response): Promise<Pool | undefined> {
    const pg = academicDatabase(config.databaseUrl);
    if (!pg) {
      res.status(503).json({ error: "Catalogul Profesor necesită PostgreSQL. Pornește serviciul postgres." });
      return undefined;
    }
    try {
      await ensureAcademicSchema(config.databaseUrl);
      return pg;
    } catch (error) {
      log.warn("PostgreSQL catalog unavailable:", error instanceof Error ? error.message : error);
      res.status(503).json({ error: CATALOG_UNAVAILABLE });
      return undefined;
    }
  }
  const ownedGroup = async (pg: Pool, groupId: string, ownerId: number) => (await pg.query("SELECT id FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, ownerId])).rowCount;
  /** Malformed ids cannot exist, so they are reported as not found instead of a database error. */
  const parseUuid = (value: unknown, notFound: string) => {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) throw new HttpError(404, notFound);
    return parsed.data;
  };
  /** Group names are unique per owner regardless of letter case (si-265 = SI-265). */
  const assertGroupNameFree = async (pg: Pool, ownerId: number, name: string, exceptId?: string) => {
    const clash = await pg.query("SELECT name FROM academic_groups WHERE owner_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1", [ownerId, name, exceptId ?? null]);
    if (clash.rowCount) throw new HttpError(409, groupExists(clash.rows[0].name));
  };
  const GROUP_COLUMNS = "g.id, g.owner_id, g.name, g.subject, g.created_at, (SELECT COUNT(*)::int FROM students s WHERE s.group_id=g.id) AS student_count";
  const GRADE_COLUMNS = "id, student_id, laboratory, presented_on::text AS presented_on, grade::float8 AS grade, feedback, created_at";

  app.get("/api/teacher/groups", auth, async (req, res) => {
    const pg = await catalog(res); if (!pg) return;
    // Display order (Romanian collation) is applied by the client; the server order is only a stable default.
    const result = await pg.query(`SELECT ${GROUP_COLUMNS} FROM academic_groups g WHERE g.owner_id=$1 ORDER BY lower(g.name), g.name`, [userOf(req).id]);
    res.json(result.rows);
  });
  app.post("/api/teacher/groups", auth, async (req, res) => {
    const input = groupSchema.parse(req.body); const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    const count = (await pg.query("SELECT COUNT(*)::int AS count FROM academic_groups WHERE owner_id=$1", [ownerId])).rows[0].count as number;
    if (count >= LIMITS.groupsPerTeacher) throw new HttpError(409, `Ai atins limita de ${LIMITS.groupsPerTeacher} grupe.`);
    await assertGroupNameFree(pg, ownerId, input.name);
    const result = await pg.query("INSERT INTO academic_groups(owner_id,name,subject) VALUES($1,$2,$3) RETURNING id, owner_id, name, subject, created_at, 0 AS student_count", [ownerId, input.name, input.subject]);
    res.status(201).json(result.rows[0]);
  });
  app.patch("/api/teacher/groups/:groupId", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); const input = groupPatchSchema.parse(req.body); const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    if (!await ownedGroup(pg, groupId, ownerId)) return res.status(404).json({ error: GROUP_NOT_FOUND });
    if (input.name !== undefined) await assertGroupNameFree(pg, ownerId, input.name, groupId);
    await pg.query("UPDATE academic_groups SET name=COALESCE($3, name), subject=CASE WHEN $4 THEN $5 ELSE subject END WHERE id=$1 AND owner_id=$2",
      [groupId, ownerId, input.name ?? null, input.subject !== undefined, input.subject ?? null]);
    const result = await pg.query(`SELECT ${GROUP_COLUMNS} FROM academic_groups g WHERE g.id=$1 AND g.owner_id=$2`, [groupId, ownerId]);
    if (!result.rowCount) return res.status(404).json({ error: GROUP_NOT_FOUND });
    res.json(result.rows[0]);
  });
  /** Deletes the group with its students, attendance and grades (ON DELETE CASCADE). */
  app.delete("/api/teacher/groups/:groupId", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    const result = await pg.query("DELETE FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, userOf(req).id]);
    if (!result.rowCount) return res.status(404).json({ error: GROUP_NOT_FOUND });
    res.status(204).end();
  });
  app.get("/api/teacher/groups/:groupId/students", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    if (!await ownedGroup(pg, groupId, userOf(req).id)) return res.status(404).json({ error: GROUP_NOT_FOUND });
    const result = await pg.query("SELECT * FROM students WHERE group_id=$1 ORDER BY last_name,first_name", [groupId]);
    res.json(result.rows);
  });
  app.post("/api/teacher/groups/:groupId/students", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); const input = studentSchema.parse(req.body);
    const pg = await catalog(res); if (!pg) return;
    if (!await ownedGroup(pg, groupId, userOf(req).id)) return res.status(404).json({ error: GROUP_NOT_FOUND });
    const count = (await pg.query("SELECT COUNT(*)::int AS count FROM students WHERE group_id=$1", [groupId])).rows[0].count as number;
    if (count >= LIMITS.studentsPerGroup) throw new HttpError(409, `Grupa a atins limita de ${LIMITS.studentsPerGroup} studenți.`);
    const result = await pg.query("INSERT INTO students(group_id,first_name,last_name) VALUES($1,$2,$3) RETURNING *", [groupId, input.firstName, input.lastName]);
    res.status(201).json(result.rows[0]);
  });
  const OWNED_STUDENT = "SELECT s.id FROM students s JOIN academic_groups g ON g.id=s.group_id WHERE s.id=$1 AND g.owner_id=$2";
  app.patch("/api/teacher/students/:studentId", auth, async (req, res) => {
    const studentId = parseUuid(req.params.studentId, STUDENT_NOT_FOUND); const input = studentPatchSchema.parse(req.body);
    const pg = await catalog(res); if (!pg) return;
    const result = await pg.query(`UPDATE students SET first_name=COALESCE($3, first_name), last_name=COALESCE($4, last_name) WHERE id IN (${OWNED_STUDENT}) RETURNING *`,
      [studentId, userOf(req).id, input.firstName ?? null, input.lastName ?? null]);
    if (!result.rowCount) return res.status(404).json({ error: STUDENT_NOT_FOUND });
    res.json(result.rows[0]);
  });
  /** Deletes the student with their attendance entries and grades (ON DELETE CASCADE). */
  app.delete("/api/teacher/students/:studentId", auth, async (req, res) => {
    const studentId = parseUuid(req.params.studentId, STUDENT_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    const result = await pg.query(`DELETE FROM students WHERE id IN (${OWNED_STUDENT})`, [studentId, userOf(req).id]);
    if (!result.rowCount) return res.status(404).json({ error: STUDENT_NOT_FOUND });
    res.status(204).end();
  });
  /** Saved attendance of one day (default: today in the university time zone). */
  app.get("/api/teacher/groups/:groupId/attendance", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND);
    const date = attendanceQuerySchema.parse({ date: req.query.date }).date ?? isoDateInChisinau();
    const pg = await catalog(res); if (!pg) return;
    if (!await ownedGroup(pg, groupId, userOf(req).id)) return res.status(404).json({ error: GROUP_NOT_FOUND });
    const session = await pg.query("SELECT id, topic FROM attendance_sessions WHERE group_id=$1 AND occurred_on=$2", [groupId, date]);
    const entries = session.rowCount
      ? (await pg.query("SELECT e.student_id AS \"studentId\", e.status FROM attendance_entries e WHERE e.session_id=$1 ORDER BY e.student_id", [session.rows[0].id])).rows
      : [];
    res.json({ date, sessionId: session.rows[0]?.id ?? null, topic: session.rows[0]?.topic ?? null, entries });
  });
  app.post("/api/teacher/groups/:groupId/attendance", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); const input = attendanceSchema.parse(req.body);
    const pg = await catalog(res); if (!pg) return;
    const entries = [...new Map(input.entries.map((entry) => [entry.studentId.toLowerCase(), entry.status])).entries()];
    const client = await pg.connect();
    try {
      await client.query("BEGIN");
      const group = await client.query("SELECT id FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, userOf(req).id]);
      if (!group.rowCount) throw new HttpError(404, GROUP_NOT_FOUND);
      const session = await client.query("INSERT INTO attendance_sessions(group_id,occurred_on,topic) VALUES($1,$2,$3) ON CONFLICT(group_id,occurred_on) DO UPDATE SET topic=COALESCE(EXCLUDED.topic, attendance_sessions.topic) RETURNING id", [groupId, input.date, input.topic]);
      if (entries.length) {
        // Only students of this group can be marked; anything else aborts the whole request.
        const saved = await client.query(`INSERT INTO attendance_entries(session_id,student_id,status)
          SELECT $1, s.id, e.status FROM unnest($2::uuid[], $3::text[]) AS e(student_id, status) JOIN students s ON s.id=e.student_id AND s.group_id=$4
          ON CONFLICT(session_id,student_id) DO UPDATE SET status=EXCLUDED.status`, [session.rows[0].id, entries.map(([id]) => id), entries.map(([, status]) => status), groupId]);
        if (saved.rowCount !== entries.length) throw new HttpError(400, "Unii studenți nu aparțin acestei grupe.");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    res.status(204).end();
  });
  app.get("/api/teacher/students/:studentId/grades", auth, async (req, res) => {
    const studentId = parseUuid(req.params.studentId, STUDENT_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    const owned = await pg.query(OWNED_STUDENT, [studentId, userOf(req).id]);
    if (!owned.rowCount) return res.status(404).json({ error: STUDENT_NOT_FOUND });
    const result = await pg.query(`SELECT ${GRADE_COLUMNS} FROM lab_grades WHERE student_id=$1 ORDER BY created_at, id`, [studentId]);
    res.json(result.rows);
  });
  /** One grade per laboratory: saving the same laboratory again replaces the grade (201 created, 200 replaced). */
  app.post("/api/teacher/students/:studentId/grades", auth, async (req, res) => {
    const studentId = parseUuid(req.params.studentId, STUDENT_NOT_FOUND); const input = gradeSchema.parse(req.body);
    const pg = await catalog(res); if (!pg) return;
    const result = await pg.query(`INSERT INTO lab_grades(student_id,laboratory,grade,presented_on,feedback)
      SELECT s.id,$3,$4,$5,$6 FROM students s JOIN academic_groups g ON g.id=s.group_id WHERE s.id=$1 AND g.owner_id=$2
      ON CONFLICT(student_id,laboratory) DO UPDATE SET grade=EXCLUDED.grade, presented_on=EXCLUDED.presented_on, feedback=EXCLUDED.feedback, created_at=now()
      RETURNING ${GRADE_COLUMNS}, (xmax = 0) AS inserted`, [studentId, userOf(req).id, input.laboratory, input.grade, input.presentedOn ?? null, input.feedback]);
    if (!result.rowCount) return res.status(404).json({ error: STUDENT_NOT_FOUND });
    const { inserted, ...grade } = result.rows[0];
    res.status(inserted ? 201 : 200).json(grade);
  });

  // ---- Telegram webhook (only active in webhook mode, authenticated by the secret token) ----
  app.post("/telegram/webhook", async (req, res) => {
    if (!config.token || config.polling) return res.status(404).json({ error: "Not found" });
    const supplied = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(supplied, webhookSecret(config))) return res.status(401).json({ error: "Unauthorized" });
    try {
      await handleBotMessage(db, config, req.body?.message);
    } catch (error) {
      // Always acknowledge: a non-2xx answer makes Telegram redeliver the same update repeatedly.
      log.error("Telegram webhook handling failed:", error instanceof Error ? error.message : error);
    }
    res.sendStatus(200);
  });

  app.use((_req: Request, res: Response) => res.status(404).json({ error: "Resursa nu a fost găsită" }));

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError) return res.status(400).json({ error: "Date invalide", fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    const details = (error ?? {}) as { type?: string, status?: number, code?: string, constraint?: string };
    if (details.type === "entity.parse.failed") return res.status(400).json({ error: "Corpul cererii nu este JSON valid" });
    if (details.type === "entity.too.large") return res.status(413).json({ error: "Cererea este prea mare" });
    if (typeof details.status === "number" && details.status >= 400 && details.status < 500) return res.status(details.status).json({ error: "Cerere invalidă" });
    // PostgreSQL constraint errors caused by user input.
    if (isConnectionError(error)) {
      // PostgreSQL went away after startup: re-check the schema once it is reachable again.
      resetAcademicSchema();
      log.warn("PostgreSQL catalog unavailable:", error instanceof Error ? error.message : error);
      return res.status(503).json({ error: CATALOG_UNAVAILABLE });
    }
    if (details.code === "23505" && details.constraint?.startsWith("academic_groups")) return res.status(409).json({ error: "Ai deja o grupă cu acest nume (literele mari și mici nu contează)." });
    if (details.code === "23505") return res.status(409).json({ error: "Există deja o înregistrare cu aceste date (de ex. o grupă cu același nume)." });
    if (details.code === "23503") return res.status(404).json({ error: "Resursa asociată nu a fost găsită" });
    if (details.code === "22008" || details.code === "22007") return res.status(400).json({ error: "Data nu este validă" });
    if (details.code === "22P02" || details.code === "22003" || details.code === "23514") return res.status(400).json({ error: "Date invalide" });
    log.error("Unhandled request error:", error);
    res.status(500).json({ error: "Eroare internă" });
  });

  return app;
}
