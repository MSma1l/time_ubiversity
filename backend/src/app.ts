import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Pool, PoolClient } from "pg";
import { ZodError } from "zod";
import { academicDatabase, academicHealth, ensureAcademicSchema, isConnectionError, resetAcademicSchema } from "./academic.js";
import { handleBotMessage, webhookSecret } from "./bot.js";
import type { AppConfig } from "./config.js";
import { addNotification, lessonById, lessonRows, nonWorkingDaysBetween, upsertProfile, type Lesson, type SqliteDatabase } from "./db.js";
import { backfillOwnerGroups, lockCatalogGroup, lockOwnerCatalog, ownerLessonLinks, renameLessonGroup, syncLessonGroup, withLessonLinks } from "./groupSync.js";
import { ProfileRuleError, readProfile, updateProfile, type Profile } from "./profile.js";
import { createRateLimiter, rateLimitMiddleware } from "./rateLimit.js";
import { addDays, isoDateInChisinau, isoWeekday, isValidIsoDate, SEMESTER_REFERENCE_KIND, SEMESTER_REFERENCE_MONDAY, weekInfo } from "./schedule.js";
import { safeEqual, validateInitData, type TelegramUser } from "./telegram.js";
import { attendanceQuerySchema, attendanceSchema, gradeSchema, groupPatchSchema, groupSchema, laboratorySchema, lessonIdSchema, lessonSchema, lessonUpdateSchema, nonWorkingRangeSchema, notificationsReadSchema, profilePatchSchema, studentPatchSchema, studentSchema, uuidSchema } from "./validation.js";

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

  const ipLimiter = createRateLimiter(config.rateLimitPerMinute * 5);
  const userLimiter = createRateLimiter(config.rateLimitPerMinute);
  // /health is public and is registered before the /api limiter, so it gets its own generous one:
  // without it a flood of health checks exhausts the PostgreSQL pool used by the Teacher Catalog.
  const healthLimiter = createRateLimiter(60);
  setInterval(() => { ipLimiter.prune(); userLimiter.prune(); healthLimiter.prune(); }, 60_000).unref();

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
  const healthLimit = rateLimitMiddleware(healthLimiter, (req) => `ip:${req.ip ?? "unknown"}`);
  app.get("/health", healthLimit, health);
  app.get("/api/health", healthLimit, health);

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
    // Teacher Catalog routes run `auth` twice (mount + route); the second pass must not count again.
    if ((req as Partial<AuthRequest>).telegramUser) return next();
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
  /**
   * The profile as the API exposes it. The schedule is the university's, so there is no personal time zone:
   * the fields are listed explicitly to keep an internal column from leaking into the answer.
   */
  const publicProfile = (profile: Profile | undefined) => profile && {
    telegramId: profile.telegramId, displayName: profile.displayName, role: profile.role,
    studentEnabled: profile.studentEnabled, teacherEnabled: profile.teacherEnabled, remindersEnabled: profile.remindersEnabled
  };

  app.get("/api/me", auth, (req, res) => {
    const user = userOf(req);
    res.json({ profile: publicProfile(profileOf(user.id)), telegram: { id: user.id, firstName: user.first_name, username: user.username } });
  });
  app.patch("/api/me", auth, (req, res) => {
    const body = profilePatchSchema.parse(req.body);
    // Mode rules (profile.ts) are checked on the merged profile inside one transaction.
    try {
      res.json(publicProfile(updateProfile(db, userOf(req).id, body)));
    } catch (error) {
      if (error instanceof ProfileRuleError) return res.status(409).json({ error: error.message });
      throw error;
    }
  });
  /** Monday → Sunday of one date: the calendar marks the free days of the whole displayed week. */
  const weekBounds = (isoDate: string) => {
    const monday = addDays(isoDate, 1 - isoWeekday(isoDate));
    return { monday, sunday: addDays(monday, 6) };
  };
  /**
   * The single source of truth for week numbering: with several semesters the parity restarts at each
   * of them, so no client can still derive it from one hardcoded anchor. `semesters` lets the interface
   * mark the breaks, `nonWorkingDays` covers the displayed week (Monday→Sunday), not only the date asked.
   */
  app.get("/api/week", auth, (req, res) => {
    const date = req.query.date;
    if (date !== undefined && !isValidIsoDate(date)) return res.status(400).json({ error: "Data trebuie să fie în format YYYY-MM-DD" });
    const requested = date ?? isoDateInChisinau();
    const { monday, sunday } = weekBounds(requested);
    res.json({
      ...weekInfo(requested, config.semesters),
      semesters: config.semesters,
      nonWorkingDays: nonWorkingDaysBetween(db, monday, sunday),
      // @deprecated referenceMonday / referenceKind: the old single global anchor, replaced by `semesters`.
      // Kept one more version so clients released before the semesters still render a week; remove afterwards.
      referenceMonday: SEMESTER_REFERENCE_MONDAY, referenceKind: SEMESTER_REFERENCE_KIND
    });
  });
  /**
   * Free days of a closed interval, for a calendar that paints more than one week at a time.
   * Read-only on purpose. There is no administrator in this application — a profile only has
   * `studentEnabled` / `teacherEnabled`, and every authenticated Telegram user gets both — while a
   * non-working day is institution-wide: it hides lessons and silences the reminders of *everyone*.
   * A write route reachable by any user would therefore be a one-request denial of service on the
   * whole university's reminders, and no rule available here (role, mode, ownership) can tell an
   * administrator apart. Until a real administrator model exists, adding and removing free days stays
   * a server-side operation (`setNonWorkingDay` / `removeNonWorkingDay` in db.ts, run on the server —
   * see docs), which is why no POST/DELETE is registered here.
   */
  app.get("/api/non-working-days", auth, (req, res) => {
    const { from, to } = nonWorkingRangeSchema.parse({ from: req.query.from, to: req.query.to });
    res.json(nonWorkingDaysBetween(db, from, to));
  });

  const roleLabel = (role: string) => role === "teacher" ? "Profesor" : "Student";

  /**
   * After a teacher lesson is saved (SQLite already committed), make sure its group exists in the Teacher
   * Catalog. Timing: awaited for at most GROUP_SYNC_WAIT_MS so the group is usually visible right away;
   * a slower sync keeps running in the background. It never fails the lesson request (see groupSync.ts).
   */
  const GROUP_SYNC_WAIT_MS = 1_500;
  const syncGroupOf = async (ownerId: number, lesson: Lesson | undefined) => {
    if (!lesson || lesson.role !== "teacher" || !lesson.groupName?.trim() || !config.databaseUrl) return;
    const task = syncLessonGroup(config.databaseUrl, ownerId, lesson, LIMITS.groupsPerTeacher, log);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, GROUP_SYNC_WAIT_MS); timer.unref(); })]);
    clearTimeout(timer);
  };

  // Student and Profesor schedules are two separate lists of the same user, told apart by `role`.
  app.get("/api/lessons", auth, (req, res) => {
    const role = req.query.role;
    if (role !== undefined && role !== "student" && role !== "teacher") return res.status(400).json({ error: "Rolul trebuie să fie student sau teacher" });
    res.json(lessonRows(db, userOf(req).id, role));
  });
  app.post("/api/lessons", auth, async (req, res) => {
    const input = lessonSchema.parse(req.body); const ownerId = userOf(req).id;
    const count = (db.prepare("SELECT COUNT(*) AS count FROM lessons WHERE owner_id=?").get(ownerId) as { count: number }).count;
    if (count >= LIMITS.lessonsPerUser) throw new HttpError(409, `Ai atins limita de ${LIMITS.lessonsPerUser} ore în orar.`);
    const created = db.transaction(() => {
      const result = db.prepare(`INSERT INTO lessons (owner_id,role,title,group_name,teacher_name,room,weekday,start_time,end_time,week_kind,reminder_minutes,notifications_enabled) VALUES (@ownerId,@role,@title,@groupName,@teacherName,@room,@weekday,@startTime,@endTime,@weekKind,@reminderMinutes,@notificationsEnabled)`)
        .run({ ...input, ownerId, notificationsEnabled: Number(input.notificationsEnabled) });
      addNotification(db, ownerId, "system", "Orar actualizat", `Ai adăugat în orarul de ${roleLabel(input.role)}: ${input.title}, ${input.startTime}–${input.endTime}.`, input.role);
      return lessonById(db, ownerId, result.lastInsertRowid);
    })();
    await syncGroupOf(ownerId, created);
    res.status(201).json(created);
  });
  app.put("/api/lessons/:id", auth, async (req, res) => {
    const id = lessonIdSchema.parse(req.params.id); const input = lessonUpdateSchema.parse(req.body); const ownerId = userOf(req).id;
    // A missing role keeps the lesson in the schedule it already belongs to.
    const result = db.prepare(`UPDATE lessons SET role=COALESCE(@role, role),title=@title,group_name=@groupName,teacher_name=@teacherName,room=@room,weekday=@weekday,start_time=@startTime,end_time=@endTime,week_kind=@weekKind,reminder_minutes=@reminderMinutes,notifications_enabled=@notificationsEnabled,updated_at=CURRENT_TIMESTAMP WHERE id=@id AND owner_id=@ownerId`)
      .run({ ...input, role: input.role ?? null, id, ownerId, notificationsEnabled: Number(input.notificationsEnabled) });
    if (!result.changes) return res.status(404).json({ error: "Ora nu a fost găsită" });
    const updated = lessonById(db, ownerId, id);
    await syncGroupOf(ownerId, updated);
    res.json(updated);
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
  /** The catalog belongs to the Profesor mode: the rule is enforced here, not only in the interface. */
  app.use("/api/teacher", auth, (req: Request, res: Response, next: NextFunction) => {
    if (!profileOf(userOf(req).id)?.teacherEnabled) return res.status(403).json({ error: "Catalogul Profesor este disponibil doar cu modul Profesor activat. Activează-l în profil." });
    next();
  });
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
  /** Runs `work` in one PostgreSQL transaction; any error (including HttpError) rolls it back. */
  async function inTransaction<T>(pg: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pg.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
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
  const assertGroupNameFree = async (client: Pick<PoolClient, "query">, ownerId: number, name: string, exceptId?: string) => {
    const clash = await client.query("SELECT name FROM academic_groups WHERE owner_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1", [ownerId, name, exceptId ?? null]);
    if (clash.rowCount) throw new HttpError(409, groupExists(clash.rows[0].name));
  };
  const GROUP_COLUMNS = "g.id, g.owner_id, g.name, g.subject, g.created_at, (SELECT COUNT(*)::int FROM students s WHERE s.group_id=g.id) AS student_count";
  const GRADE_COLUMNS = "id, student_id, laboratory, presented_on::text AS presented_on, grade::float8 AS grade, feedback, created_at";
  const LABORATORY_COLUMNS = 'id, group_id AS "groupId", number, label, created_at AS "createdAt"';

  /**
   * Groups linked to the Profesor schedule: `linkedLessons` / `subjects` come from the owner's teacher lessons
   * whose group name matches (trimmed, case-insensitive). Links are computed, never stored: they follow the
   * name, which is why a rename is propagated to the lessons (PATCH below). Deleting a group deletes no lesson.
   */
  app.get("/api/teacher/groups", auth, async (req, res) => {
    const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    // First visit: import the groups of lessons created before the catalog link existed (once per owner).
    try {
      await backfillOwnerGroups(db, pg, ownerId, LIMITS.groupsPerTeacher, log);
    } catch (error) {
      if (isConnectionError(error)) throw error;
      log.warn(`Catalog group backfill failed for owner ${ownerId}:`, error instanceof Error ? error.message : error);
    }
    // Display order (Romanian collation) is applied by the client; the server order is only a stable default.
    const result = await pg.query(`SELECT ${GROUP_COLUMNS} FROM academic_groups g WHERE g.owner_id=$1 ORDER BY lower(g.name), g.name`, [ownerId]);
    const links = ownerLessonLinks(db, ownerId);
    res.json(result.rows.map((group) => withLessonLinks(group, links)));
  });
  app.post("/api/teacher/groups", auth, async (req, res) => {
    const input = groupSchema.parse(req.body); const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    const created = await inTransaction(pg, async (client) => {
      // COUNT and INSERT are separated by awaits: without the lock two parallel requests of the same
      // teacher at `limit - 1` groups would both pass the check and exceed the limit.
      await lockOwnerCatalog(client, ownerId);
      const count = (await client.query("SELECT COUNT(*)::int AS count FROM academic_groups WHERE owner_id=$1", [ownerId])).rows[0].count as number;
      if (count >= LIMITS.groupsPerTeacher) throw new HttpError(409, `Ai atins limita de ${LIMITS.groupsPerTeacher} grupe.`);
      await assertGroupNameFree(client, ownerId, input.name);
      return (await client.query("INSERT INTO academic_groups(owner_id,name,subject) VALUES($1,$2,$3) RETURNING id, owner_id, name, subject, created_at, 0 AS student_count",
        [ownerId, input.name, input.subject])).rows[0];
    });
    res.status(201).json(withLessonLinks(created, ownerLessonLinks(db, ownerId)));
  });
  /**
   * Renaming the group renames it in the owner's Profesor lessons too (same `groupKey` matching, Student
   * schedule untouched): the link follows the name, so a rename left only in the catalog would unlink the
   * lessons and the next lesson save would recreate the old name as a second, empty group. A rename that
   * changes only the letter case still rewrites the text shown in the schedule.
   * Write order: SQLite is renamed inside the PostgreSQL transaction, just before COMMIT. A SQLite failure
   * rolls the catalog back (nothing changes anywhere); if only the COMMIT fails, the schedule is renamed
   * and the catalog is not, which repeating the very same request repairs (the reverse order could not be
   * repaired: the old name would be gone from the catalog and no request could still find the lessons).
   */
  app.patch("/api/teacher/groups/:groupId", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); const input = groupPatchSchema.parse(req.body); const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    const group = await inTransaction(pg, async (client) => {
      // The same lock as the lesson → catalog sync: a rename cannot race the creation of the old name.
      await lockOwnerCatalog(client, ownerId);
      const current = await client.query("SELECT name FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, ownerId]);
      if (!current.rowCount) throw new HttpError(404, GROUP_NOT_FOUND);
      if (input.name !== undefined) await assertGroupNameFree(client, ownerId, input.name, groupId);
      await client.query("UPDATE academic_groups SET name=COALESCE($3, name), subject=CASE WHEN $4 THEN $5 ELSE subject END WHERE id=$1 AND owner_id=$2",
        [groupId, ownerId, input.name ?? null, input.subject !== undefined, input.subject ?? null]);
      const result = await client.query(`SELECT ${GROUP_COLUMNS} FROM academic_groups g WHERE g.id=$1 AND g.owner_id=$2`, [groupId, ownerId]);
      if (!result.rowCount) throw new HttpError(404, GROUP_NOT_FOUND);
      if (input.name !== undefined) renameLessonGroup(db, ownerId, current.rows[0].name as string, input.name);
      return result.rows[0];
    });
    res.json(withLessonLinks(group, ownerLessonLinks(db, ownerId)));
  });
  /** Deletes the group with its students, attendance and grades (ON DELETE CASCADE). Lessons are never deleted. */
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
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); const input = studentSchema.parse(req.body); const ownerId = userOf(req).id;
    const pg = await catalog(res); if (!pg) return;
    const created = await inTransaction(pg, async (client) => {
      // Same reason as for groups: COUNT and INSERT must not interleave with a parallel request.
      await lockCatalogGroup(client, groupId);
      if (!(await client.query("SELECT id FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, ownerId])).rowCount) throw new HttpError(404, GROUP_NOT_FOUND);
      const count = (await client.query("SELECT COUNT(*)::int AS count FROM students WHERE group_id=$1", [groupId])).rows[0].count as number;
      if (count >= LIMITS.studentsPerGroup) throw new HttpError(409, `Grupa a atins limita de ${LIMITS.studentsPerGroup} studenți.`);
      return (await client.query("INSERT INTO students(group_id,first_name,last_name) VALUES($1,$2,$3) RETURNING *", [groupId, input.firstName, input.lastName])).rows[0];
    });
    res.status(201).json(created);
  });
  /** Persistent group-level laboratories. The group lock makes the next number race-safe. */
  app.get("/api/teacher/groups/:groupId/laboratories", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    if (!await ownedGroup(pg, groupId, userOf(req).id)) return res.status(404).json({ error: GROUP_NOT_FOUND });
    const result = await pg.query(`SELECT ${LABORATORY_COLUMNS} FROM laboratories WHERE group_id=$1 ORDER BY number`, [groupId]);
    res.json(result.rows);
  });
  app.post("/api/teacher/groups/:groupId/laboratories", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND); laboratorySchema.parse(req.body ?? {});
    const pg = await catalog(res); if (!pg) return;
    const laboratory = await inTransaction(pg, async (client) => {
      await lockCatalogGroup(client, groupId);
      if (!(await client.query("SELECT id FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, userOf(req).id])).rowCount) throw new HttpError(404, GROUP_NOT_FOUND);
      const next = (await client.query("SELECT COALESCE(MAX(number),0)::int + 1 AS number FROM laboratories WHERE group_id=$1", [groupId])).rows[0].number as number;
      return (await client.query(`INSERT INTO laboratories(group_id,number,label) VALUES($1,$2,$3) RETURNING ${LABORATORY_COLUMNS}`,
        [groupId, next, `Laborator ${next}`])).rows[0];
    });
    res.status(201).json(laboratory);
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
      // A missing `topic` keeps the saved one; an empty one (null after validation) clears it.
      const session = await client.query("INSERT INTO attendance_sessions(group_id,occurred_on,topic) VALUES($1,$2,$3) ON CONFLICT(group_id,occurred_on) DO UPDATE SET topic=CASE WHEN $4 THEN EXCLUDED.topic ELSE attendance_sessions.topic END RETURNING id",
        [groupId, input.date, input.topic ?? null, input.topic !== undefined]);
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
  /** Group review. Missing marks and grades are intentionally separate from absences and zeroes. */
  app.get("/api/teacher/groups/:groupId/statistics", auth, async (req, res) => {
    const groupId = parseUuid(req.params.groupId, GROUP_NOT_FOUND);
    const pg = await catalog(res); if (!pg) return;
    const group = await pg.query("SELECT id,name FROM academic_groups WHERE id=$1 AND owner_id=$2", [groupId, userOf(req).id]);
    if (!group.rowCount) return res.status(404).json({ error: GROUP_NOT_FOUND });
    const studentCount = (await pg.query("SELECT COUNT(*)::int AS count FROM students WHERE group_id=$1", [groupId])).rows[0].count as number;
    const attendanceRows = await pg.query(`SELECT a.occurred_on::text AS date, a.topic, COUNT(e.student_id)::int AS recorded,
      COUNT(e.student_id) FILTER (WHERE e.status='present')::int AS present, COUNT(e.student_id) FILTER (WHERE e.status='absent')::int AS absent,
      COUNT(e.student_id) FILTER (WHERE e.status='late')::int AS late FROM attendance_sessions a LEFT JOIN attendance_entries e ON e.session_id=a.id
      WHERE a.group_id=$1 GROUP BY a.id,a.occurred_on,a.topic ORDER BY a.occurred_on DESC`, [groupId]);
    const sessions = attendanceRows.rows.map((row) => ({ ...row, unmarked: Math.max(0, studentCount - Number(row.recorded)) }));
    const attendance = sessions.reduce((total, row) => ({ sessionCount: total.sessionCount + 1, recordedCount: total.recordedCount + Number(row.recorded), presentCount: total.presentCount + Number(row.present), absentCount: total.absentCount + Number(row.absent), lateCount: total.lateCount + Number(row.late), unmarkedCount: total.unmarkedCount + row.unmarked }), { sessionCount: 0, recordedCount: 0, presentCount: 0, absentCount: 0, lateCount: 0, unmarkedCount: 0 });
    const laboratoryRows = await pg.query(`SELECT l.id,l.number,l.label,COUNT(lg.id)::int AS "gradedCount",AVG(lg.grade)::float8 AS average,MIN(lg.grade)::float8 AS min,MAX(lg.grade)::float8 AS max
      FROM laboratories l LEFT JOIN students s ON s.group_id=l.group_id LEFT JOIN lab_grades lg ON lg.student_id=s.id AND lg.laboratory=l.label
      WHERE l.group_id=$1 GROUP BY l.id,l.number,l.label ORDER BY l.number`, [groupId]);
    const laboratories = laboratoryRows.rows.map((row) => ({ ...row, missingCount: Math.max(0, studentCount - Number(row.gradedCount)) }));
    const overall = (await pg.query("SELECT COUNT(lg.id)::int AS \"gradedCount\",AVG(lg.grade)::float8 AS average FROM lab_grades lg JOIN students s ON s.id=lg.student_id WHERE s.group_id=$1", [groupId])).rows[0];
    const students = (await pg.query(`SELECT s.id,s.first_name AS "firstName",s.last_name AS "lastName",COALESCE(a.present,0)::int AS present,COALESCE(a.absent,0)::int AS absent,COALESCE(a.late,0)::int AS late,COALESCE(g."gradedCount",0)::int AS "gradedCount",g.average::float8 AS average FROM students s
      LEFT JOIN (SELECT e.student_id,COUNT(*) FILTER (WHERE e.status='present')::int AS present,COUNT(*) FILTER (WHERE e.status='absent')::int AS absent,COUNT(*) FILTER (WHERE e.status='late')::int AS late FROM attendance_entries e JOIN attendance_sessions a ON a.id=e.session_id WHERE a.group_id=$1 GROUP BY e.student_id) a ON a.student_id=s.id
      LEFT JOIN (SELECT lg.student_id,COUNT(*)::int AS "gradedCount",AVG(lg.grade)::float8 AS average FROM lab_grades lg JOIN students si ON si.id=lg.student_id WHERE si.group_id=$1 GROUP BY lg.student_id) g ON g.student_id=s.id
      WHERE s.group_id=$1 ORDER BY s.last_name,s.first_name`, [groupId])).rows;
    const attendanceDetails = await pg.query(`SELECT e.student_id AS "studentId",e.status,a.occurred_on::text AS date,a.topic
      FROM attendance_entries e JOIN attendance_sessions a ON a.id=e.session_id
      WHERE a.group_id=$1 AND e.status IN ('absent','late') ORDER BY e.student_id,a.occurred_on DESC`, [groupId]);
    const gradeDetails = await pg.query(`SELECT lg.id,lg.student_id AS "studentId",lg.laboratory,lg.grade::float8 AS grade,lg.presented_on::text AS "presentedOn"
      FROM lab_grades lg JOIN students s ON s.id=lg.student_id LEFT JOIN laboratories l ON l.group_id=s.group_id AND l.label=lg.laboratory
      WHERE s.group_id=$1 ORDER BY lg.student_id,l.number NULLS LAST,lg.laboratory`, [groupId]);
    const detailsByStudent = new Map<string, { attendanceEvents: unknown[], grades: unknown[] }>(students.map((student) => [student.id as string, { attendanceEvents: [], grades: [] }]));
    for (const row of attendanceDetails.rows) detailsByStudent.get(row.studentId as string)?.attendanceEvents.push(row);
    for (const row of gradeDetails.rows) detailsByStudent.get(row.studentId as string)?.grades.push(row);
    res.json({ group: group.rows[0], studentCount, attendance: { ...attendance, sessions }, grades: { ...overall, laboratories }, students: students.map((student) => ({ ...student, ...(detailsByStudent.get(student.id as string) ?? { attendanceEvents: [], grades: [] }) })) });
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
  app.post("/telegram/webhook", (req, res) => {
    if (!config.token || config.polling) return res.status(404).json({ error: "Not found" });
    const supplied = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(supplied, webhookSecret(config))) return res.status(401).json({ error: "Unauthorized" });
    // Acknowledge first, handle after: a slow answer (or a non-2xx one) makes Telegram redeliver the same update.
    const message = req.body?.message;
    res.sendStatus(200);
    void handleBotMessage(db, config, message).catch((error) => log.error("Telegram webhook handling failed:", error instanceof Error ? error.message : error));
  });

  app.use((_req: Request, res: Response) => res.status(404).json({ error: "Resursa nu a fost găsită" }));

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError) return res.status(400).json({ error: "Date invalide", fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof ProfileRuleError) return res.status(error.status).json({ error: error.message });
    const details = (error ?? {}) as { type?: string, status?: number, code?: string, constraint?: string };
    if (details.type === "entity.parse.failed") return res.status(400).json({ error: "Corpul cererii nu este JSON valid" });
    if (details.type === "entity.too.large") return res.status(413).json({ error: "Cererea este prea mare" });
    // Only body-parser errors (they always carry a `type`); other errors with a `status` are ours and keep their meaning.
    if (typeof details.type === "string" && typeof details.status === "number" && details.status >= 400 && details.status < 500) return res.status(details.status).json({ error: "Cerere invalidă" });
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
