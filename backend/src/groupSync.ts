import type { Pool } from "pg";
import { academicDatabase, ensureAcademicSchema, isConnectionError, resetAcademicSchema } from "./academic.js";
import type { Lesson, SqliteDatabase } from "./db.js";

/**
 * Link between the Profesor schedule (SQLite lessons) and the Teacher Catalog (PostgreSQL groups).
 *
 * - A lesson and a catalog group are linked when their group names match trimmed and case-insensitively
 *   (see `groupKey`). The link is computed, never stored.
 * - Saving a teacher lesson with a group ensures that group exists in the catalog (created with the lesson
 *   title as subject). Existing groups are never modified.
 * - Lessons that existed before this feature are imported once per owner (backfill, tracked in the SQLite
 *   table `catalog_group_sync`). Groups the teacher deletes afterwards are not re-imported by the backfill;
 *   only a later save of a lesson with that group recreates it.
 * - Renaming a catalog group never changes lessons, and deleting a group never deletes lessons: the
 *   catalog is the teacher's register, the schedule stays untouched.
 */

type WarnLog = Pick<Console, "warn">;
type LessonGroupSource = Pick<Lesson, "groupName" | "title">;

const GROUP_NAME_MAX = 80;
const SUBJECT_MAX = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SYNC_LOCK_NAMESPACE = 727274002;

/** Matching key for lesson and catalog group names: trimmed, case-insensitive. Empty means "no group". */
export function groupKey(name: string | null | undefined): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

export type GroupCandidate = { name: string, subject: string | null };

/**
 * Distinct catalog groups implied by lessons (in the given order). The first lesson of a group decides the
 * spelling and the subject. Names the catalog cannot store (too long, control characters) are skipped.
 */
export function collectGroupCandidates(lessons: LessonGroupSource[]): GroupCandidate[] {
  const seen = new Map<string, GroupCandidate>();
  for (const lesson of lessons) {
    const name = lesson.groupName?.trim() ?? "";
    const key = groupKey(name);
    if (!key || seen.has(key) || name.length > GROUP_NAME_MAX || CONTROL_CHARACTERS.test(name)) continue;
    const subject = lesson.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, SUBJECT_MAX).trim();
    seen.set(key, { name, subject: subject || null });
  }
  return [...seen.values()];
}

/** Teacher lessons of the owner that name a group, oldest first. */
export function teacherLessonGroups(db: SqliteDatabase, ownerId: number): LessonGroupSource[] {
  return db.prepare("SELECT group_name AS groupName, title FROM lessons WHERE owner_id=? AND role='teacher' AND group_name IS NOT NULL AND trim(group_name)<>'' ORDER BY id")
    .all(ownerId) as LessonGroupSource[];
}

export type LessonLinks = { linkedLessons: number, subjects: string[] };

/** Per group key: how many teacher lessons use the group and their distinct titles (sorted). */
export function computeLessonLinks(lessons: LessonGroupSource[]): Map<string, LessonLinks> {
  const acc = new Map<string, { count: number, subjects: Set<string> }>();
  for (const lesson of lessons) {
    const key = groupKey(lesson.groupName);
    if (!key) continue;
    const entry = acc.get(key) ?? { count: 0, subjects: new Set<string>() };
    entry.count += 1;
    const title = lesson.title.trim();
    if (title) entry.subjects.add(title);
    acc.set(key, entry);
  }
  return new Map([...acc].map(([key, { count, subjects }]) => [key, { linkedLessons: count, subjects: [...subjects].sort((a, b) => a.localeCompare(b, "ro")) }]));
}

export function withLessonLinks<T extends { name: string }>(group: T, links: Map<string, LessonLinks>): T & LessonLinks {
  const link = links.get(groupKey(group.name));
  return { ...group, linkedLessons: link?.linkedLessons ?? 0, subjects: link ? [...link.subjects] : [] };
}

/** Links of all teacher lessons of the owner (one SQLite query). */
export const ownerLessonLinks = (db: SqliteDatabase, ownerId: number) => computeLessonLinks(teacherLessonGroups(db, ownerId));

/**
 * Creates the catalog groups that are missing for the owner (case-insensitive), respecting the per-owner
 * group limit; extra names are skipped with a log line. Works with and without the case-insensitive unique
 * index (legacy duplicates): NOT EXISTS on lower(name) plus ON CONFLICT DO NOTHING. Returns created names.
 */
export async function ensureCatalogGroups(pg: Pool, ownerId: number, candidates: GroupCandidate[], limit: number, log: WarnLog = console): Promise<string[]> {
  if (!candidates.length) return [];
  const client = await pg.connect();
  try {
    await client.query("BEGIN");
    // Serialises syncs of the same owner (lesson saves, backfill) so the limit and duplicates stay consistent.
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2::text))", [SYNC_LOCK_NAMESPACE, String(ownerId)]);
    const names = candidates.map((candidate) => candidate.name);
    const subjects = candidates.map((candidate) => candidate.subject);
    const missing = await client.query(`SELECT t.name, t.subject FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(name, subject, ord)
      WHERE NOT EXISTS (SELECT 1 FROM academic_groups g WHERE g.owner_id=$1 AND lower(g.name)=lower(t.name)) ORDER BY t.ord`, [ownerId, names, subjects]);
    if (!missing.rowCount) {
      await client.query("COMMIT");
      return [];
    }
    const count = (await client.query("SELECT COUNT(*)::int AS count FROM academic_groups WHERE owner_id=$1", [ownerId])).rows[0].count as number;
    const free = Math.max(limit - count, 0);
    const wanted = missing.rows as GroupCandidate[];
    const accepted = wanted.slice(0, free);
    const skipped = wanted.slice(free);
    if (skipped.length) log.warn(`Catalog group sync: owner ${ownerId} reached the ${limit}-group limit, skipped ${skipped.length} group(s): ${skipped.map((group) => group.name).join(", ")}`);
    let created: string[] = [];
    if (accepted.length) {
      const inserted = await client.query(`INSERT INTO academic_groups(owner_id,name,subject)
        SELECT $1, t.name, t.subject FROM unnest($2::text[], $3::text[]) AS t(name, subject)
        WHERE NOT EXISTS (SELECT 1 FROM academic_groups g WHERE g.owner_id=$1 AND lower(g.name)=lower(t.name))
        ON CONFLICT DO NOTHING RETURNING name`, [ownerId, accepted.map((group) => group.name), accepted.map((group) => group.subject)]);
      created = inserted.rows.map((row) => row.name as string);
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const isOwnerSynced = (db: SqliteDatabase, ownerId: number) =>
  Boolean(db.prepare("SELECT 1 FROM catalog_group_sync WHERE owner_id=?").get(ownerId));

/**
 * One-time import of the groups of the owner's existing teacher lessons. Marks the owner as synced only
 * after the catalog write succeeded, so a failure is retried on the next call. Returns true if it ran.
 */
export async function backfillOwnerGroups(db: SqliteDatabase, pg: Pool, ownerId: number, limit: number, log: WarnLog = console): Promise<boolean> {
  if (isOwnerSynced(db, ownerId)) return false;
  await ensureCatalogGroups(pg, ownerId, collectGroupCandidates(teacherLessonGroups(db, ownerId)), limit, log);
  db.prepare("INSERT OR IGNORE INTO catalog_group_sync(owner_id, synced_at) VALUES (?, ?)").run(ownerId, new Date().toISOString());
  return true;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Ensures the group of a saved teacher lesson exists in the catalog. Best effort: never throws; when
 * PostgreSQL is disabled or unreachable it only logs a warning (the lesson is already saved in SQLite).
 */
export async function syncLessonGroup(databaseUrl: string, ownerId: number, lesson: Pick<Lesson, "role" | "groupName" | "title"> | undefined, limit: number, log: WarnLog = console) {
  if (!lesson || lesson.role !== "teacher") return;
  const candidates = collectGroupCandidates([lesson]);
  const pg = candidates.length ? academicDatabase(databaseUrl) : undefined;
  if (!pg) return;
  try {
    await ensureAcademicSchema(databaseUrl);
    await ensureCatalogGroups(pg, ownerId, candidates, limit, log);
  } catch (error) {
    if (isConnectionError(error)) resetAcademicSchema();
    log.warn(`Catalog group sync skipped for owner ${ownerId} (lesson group "${candidates[0].name}"):`, describeError(error));
  }
}

/** Startup backfill for every owner with teacher lessons not yet synced. Never throws; errors are logged. */
export async function backfillAllCatalogGroups(db: SqliteDatabase, databaseUrl: string, limit: number, signal?: AbortSignal, log: Pick<Console, "warn" | "log"> = console) {
  const pg = academicDatabase(databaseUrl);
  if (!pg || signal?.aborted) return;
  try {
    await ensureAcademicSchema(databaseUrl);
  } catch (error) {
    log.warn("Catalog group backfill postponed (PostgreSQL not ready):", describeError(error));
    return;
  }
  const owners = (db.prepare(`SELECT DISTINCT owner_id AS ownerId FROM lessons WHERE role='teacher' AND group_name IS NOT NULL AND trim(group_name)<>''
    AND owner_id NOT IN (SELECT owner_id FROM catalog_group_sync) ORDER BY owner_id`).all() as Array<{ ownerId: number }>).map((row) => row.ownerId);
  let done = 0;
  for (const ownerId of owners) {
    if (signal?.aborted) break;
    try {
      if (await backfillOwnerGroups(db, pg, ownerId, limit, log)) done += 1;
    } catch (error) {
      log.warn(`Catalog group backfill failed for owner ${ownerId}:`, describeError(error));
      if (isConnectionError(error)) {
        resetAcademicSchema();
        break; // The remaining owners are backfilled lazily by GET /api/teacher/groups.
      }
    }
  }
  if (done) log.log(`Catalog group backfill: imported lesson groups for ${done} teacher(s)`);
}
