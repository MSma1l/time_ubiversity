import type { Pool, PoolClient } from "pg";
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
 * - Renaming a catalog group renames the group in the owner's Profesor lessons too (`renameLessonGroup`):
 *   the link follows the name, so without it the schedule would keep pointing at a name the catalog no
 *   longer has and the next lesson save would recreate that name as an empty duplicate group.
 * - Deleting a group never deletes lessons: the catalog is the teacher's register, the schedule stays.
 */

type WarnLog = Pick<Console, "warn">;
type LessonGroupSource = Pick<Lesson, "groupName" | "title">;
type Queryable = Pick<PoolClient, "query">;

const GROUP_NAME_MAX = 80;
const SUBJECT_MAX = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/**
 * PostgreSQL advisory lock namespaces of the catalog: 727274001 schema creation (academic.ts), 727274002
 * the catalog writes of one owner, 727274003 the writes inside one group. A transaction takes at most one
 * of them and never calls code that takes another, so they cannot deadlock each other.
 */
const SYNC_LOCK_NAMESPACE = 727274002;
const GROUP_LOCK_NAMESPACE = 727274003;

/** Serialises the catalog writes of one owner (group creation, rename, lesson sync). Needs an open transaction. */
export const lockOwnerCatalog = (client: Queryable, ownerId: number) =>
  client.query("SELECT pg_advisory_xact_lock($1, hashtext($2::text))", [SYNC_LOCK_NAMESPACE, String(ownerId)]);
/** Serialises the writes inside one group (student creation). Needs an open transaction. */
export const lockCatalogGroup = (client: Queryable, groupId: string) =>
  client.query("SELECT pg_advisory_xact_lock($1, hashtext($2::text))", [GROUP_LOCK_NAMESPACE, groupId]);

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
    // Sliced by code points: cutting UTF-16 units would split a surrogate pair (emoji) into "�".
    const subject = [...lesson.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, SUBJECT_MAX).join("").trim();
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
 * Applies a catalog group rename to the owner's Profesor lessons: every teacher lesson whose group matches
 * the old name (same `groupKey`: trimmed, case-insensitive) gets the new spelling, in one SQLite
 * transaction. Matching is done in JavaScript on purpose — SQLite's `lower()` only folds ASCII, so a SQL
 * comparison would silently miss names with diacritics that `groupKey` considers equal. A rename that only
 * changes letter case still rewrites the text shown in the schedule. The Student schedule is never touched.
 * Returns how many lessons changed.
 */
export function renameLessonGroup(db: SqliteDatabase, ownerId: number, previousName: string, nextName: string): number {
  const key = groupKey(previousName);
  const name = nextName.trim();
  if (!key || !name) return 0;
  const rows = db.prepare("SELECT id, group_name AS groupName FROM lessons WHERE owner_id=? AND role='teacher' AND group_name IS NOT NULL")
    .all(ownerId) as Array<{ id: number, groupName: string }>;
  const ids = rows.filter((row) => groupKey(row.groupName) === key && row.groupName !== name).map((row) => row.id);
  if (!ids.length) return 0;
  const update = db.prepare("UPDATE lessons SET group_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?");
  db.transaction(() => { for (const id of ids) update.run(name, id, ownerId); })();
  return ids.length;
}

export type CatalogSyncResult = { created: string[], skipped: number };

/**
 * Creates the catalog groups that are missing for the owner (case-insensitive), respecting the per-owner
 * group limit; extra names are skipped with a log line. Works with and without the case-insensitive unique
 * index (legacy duplicates): NOT EXISTS on lower(name) plus ON CONFLICT DO NOTHING. Returns the created
 * names and how many groups the limit left out, so the caller can tell a complete import from a partial one.
 */
export async function ensureCatalogGroups(pg: Pool, ownerId: number, candidates: GroupCandidate[], limit: number, log: WarnLog = console): Promise<CatalogSyncResult> {
  if (!candidates.length) return { created: [], skipped: 0 };
  const client = await pg.connect();
  try {
    await client.query("BEGIN");
    // Serialises syncs of the same owner (lesson saves, backfill, group create/rename) so the limit and
    // duplicates stay consistent.
    await lockOwnerCatalog(client, ownerId);
    const names = candidates.map((candidate) => candidate.name);
    const subjects = candidates.map((candidate) => candidate.subject);
    const missing = await client.query(`SELECT t.name, t.subject FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(name, subject, ord)
      WHERE NOT EXISTS (SELECT 1 FROM academic_groups g WHERE g.owner_id=$1 AND lower(g.name)=lower(t.name)) ORDER BY t.ord`, [ownerId, names, subjects]);
    if (!missing.rowCount) {
      await client.query("COMMIT");
      return { created: [], skipped: 0 };
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
    return { created, skipped: skipped.length };
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
 * after a *complete* catalog write: a failure is retried on the next call, and so is an import the
 * per-owner group limit truncated (otherwise the skipped groups would never be imported, not even with a
 * larger limit). Returns true if it ran.
 */
export async function backfillOwnerGroups(db: SqliteDatabase, pg: Pool, ownerId: number, limit: number, log: WarnLog = console): Promise<boolean> {
  if (isOwnerSynced(db, ownerId)) return false;
  const { skipped } = await ensureCatalogGroups(pg, ownerId, collectGroupCandidates(teacherLessonGroups(db, ownerId)), limit, log);
  if (skipped) {
    log.warn(`Catalog group backfill for owner ${ownerId} is incomplete (${skipped} group(s) over the limit): the owner stays unsynced and the import is retried later`);
    return true;
  }
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
