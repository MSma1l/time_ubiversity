import { Pool, type PoolClient } from "pg";
import { sleep } from "./util.js";

export type AcademicStatus = "disabled" | "connecting" | "ready" | "error";

let pool: Pool | undefined;
let schemaReady: Promise<void> | undefined;
let status: AcademicStatus = "disabled";

/** `databaseUrl` comes from `AppConfig.databaseUrl` (the single source of truth); empty disables the catalog. */
export function academicDatabase(databaseUrl: string) {
  const url = databaseUrl.trim();
  if (!url) return undefined;
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
    // Without a listener, an idle client error (e.g. PostgreSQL restart) would crash the process.
    pool.on("error", (error) => console.error("PostgreSQL pool error:", error.message));
    status = "connecting";
  }
  return pool;
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS academic_groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id BIGINT NOT NULL, name VARCHAR(80) NOT NULL, subject VARCHAR(120), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id,name));
    CREATE TABLE IF NOT EXISTS students (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES academic_groups(id) ON DELETE CASCADE, first_name VARCHAR(80) NOT NULL, last_name VARCHAR(80) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS attendance_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), group_id UUID NOT NULL REFERENCES academic_groups(id) ON DELETE CASCADE, occurred_on DATE NOT NULL, topic VARCHAR(160), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(group_id,occurred_on));
    CREATE TABLE IF NOT EXISTS attendance_entries (session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE, status VARCHAR(12) NOT NULL CHECK(status IN ('present','absent','late')), PRIMARY KEY(session_id,student_id));
    CREATE TABLE IF NOT EXISTS lab_grades (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE, laboratory VARCHAR(120) NOT NULL, presented_on DATE, grade NUMERIC(4,2) NOT NULL CHECK(grade >= 0 AND grade <= 10), feedback VARCHAR(500), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS students_group_idx ON students(group_id);
    CREATE INDEX IF NOT EXISTS attendance_entries_student_idx ON attendance_entries(student_id);
    CREATE INDEX IF NOT EXISTS lab_grades_student_idx ON lab_grades(student_id);`;

type Queryable = Pick<PoolClient, "query">;

/** Keeps only the latest grade per (student, laboratory), then enforces it with a unique index. Idempotent. */
async function migrateLabGrades(client: Queryable) {
  const exists = await client.query("SELECT to_regclass('lab_grades_student_lab_uidx') IS NOT NULL AS present");
  if (exists.rows[0].present) return;
  const removed = await client.query(`DELETE FROM lab_grades older USING lab_grades newer
    WHERE older.student_id=newer.student_id AND older.laboratory=newer.laboratory AND (older.created_at, older.id) < (newer.created_at, newer.id)`);
  if (removed.rowCount) console.warn(`PostgreSQL catalog migration: removed ${removed.rowCount} duplicate laboratory grade(s), kept the latest`);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS lab_grades_student_lab_uidx ON lab_grades(student_id, laboratory)");
}

/**
 * Group names are unique per owner regardless of letter case. Existing case-only duplicates are never
 * modified: the index is skipped (and retried on the next start) while the API still rejects new duplicates.
 */
async function migrateGroupNames(client: Queryable) {
  const exists = await client.query("SELECT to_regclass('academic_groups_owner_lower_name_uidx') IS NOT NULL AS present");
  if (exists.rows[0].present) return;
  const duplicates = await client.query("SELECT owner_id, lower(name) AS name, COUNT(*)::int AS count FROM academic_groups GROUP BY owner_id, lower(name) HAVING COUNT(*) > 1");
  if (duplicates.rowCount) {
    console.warn(`PostgreSQL catalog migration: ${duplicates.rowCount} group name(s) differ only by letter case; the case-insensitive unique index is skipped until they are renamed or deleted`);
    return;
  }
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS academic_groups_owner_lower_name_uidx ON academic_groups(owner_id, lower(name))");
}

async function createSchema(db: Pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialises schema creation across concurrent API instances / requests.
    await client.query("SELECT pg_advisory_xact_lock(727274001)");
    await client.query(SCHEMA_SQL);
    await migrateLabGrades(client);
    await migrateGroupNames(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Creates the catalog schema once per process; a failed attempt is retried on the next call. */
export async function ensureAcademicSchema(databaseUrl: string) {
  const db = academicDatabase(databaseUrl);
  if (!db) return false;
  schemaReady ??= createSchema(db).then(() => { status = "ready"; }, (error: unknown) => {
    schemaReady = undefined;
    status = "error";
    throw error;
  });
  await schemaReady;
  return true;
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03"]);
const CONNECTION_MESSAGES = /connection terminated|timeout exceeded when trying to connect|connection error|client has encountered a connection error/i;

/** True for errors meaning PostgreSQL is unreachable (as opposed to a bad query or bad input). */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message, errors } = error as { code?: unknown, message?: unknown, errors?: unknown };
  if (typeof code === "string" && (CONNECTION_CODES.has(code) || code.startsWith("08"))) return true;
  if (Array.isArray(errors) && errors.some(isConnectionError)) return true;
  return typeof code !== "string" && typeof message === "string" && CONNECTION_MESSAGES.test(message);
}

/** Forgets the cached schema check so the next catalog request re-initialises once PostgreSQL is back. */
export function resetAcademicSchema() {
  schemaReady = undefined;
  if (pool) status = "connecting";
}

/** Retries schema creation with exponential backoff until it succeeds or `signal` aborts. */
export async function initAcademicWithRetry(databaseUrl: string, signal: AbortSignal, log = console) {
  if (!academicDatabase(databaseUrl)) {
    log.warn("DATABASE_URL is not set: the Teacher Catalog (PostgreSQL) is disabled");
    return;
  }
  let delay = 1_000;
  for (let attempt = 1; !signal.aborted; attempt += 1) {
    try {
      await ensureAcademicSchema(databaseUrl);
      log.log("PostgreSQL catalog schema is ready");
      return;
    } catch (error) {
      if (attempt === 1 || attempt % 10 === 0) log.warn(`PostgreSQL catalog is not ready yet (attempt ${attempt}): ${error instanceof Error ? error.message : error}`);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/** Lightweight connectivity probe for /health. */
export async function academicHealth(databaseUrl: string): Promise<{ status: AcademicStatus }> {
  const db = academicDatabase(databaseUrl);
  if (!db) return { status: "disabled" };
  try {
    await Promise.race([
      db.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("PostgreSQL health check timed out")), 2_000).unref())
    ]);
    return { status: status === "ready" ? "ready" : "connecting" };
  } catch {
    return { status: "error" };
  }
}

export async function closeAcademicDatabase() {
  const current = pool;
  pool = undefined;
  schemaReady = undefined;
  status = "disabled";
  if (current) await current.end();
}
