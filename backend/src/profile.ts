import type { Lesson, SqliteDatabase } from "./db.js";

export type ProfileRole = Lesson["role"];
export type Profile = {
  telegramId: number; displayName: string; role: ProfileRole; timezone: string;
  studentEnabled: boolean; teacherEnabled: boolean; remindersEnabled: boolean;
};
export type ProfileChanges = { role?: ProfileRole; studentEnabled?: boolean; teacherEnabled?: boolean; remindersEnabled?: boolean };

export const PROFILE_MESSAGES = {
  atLeastOneMode: "Cel puțin un mod trebuie să rămână activ.",
  modeDisabled: (role: ProfileRole) => `Modul ${role === "teacher" ? "Profesor" : "Student"} este dezactivat. Activează-l mai întâi.`
};

/** A change that would leave the profile in an invalid state (HTTP 409). */
export class ProfileRuleError extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "ProfileRuleError"; }
}

const PROFILE_COLUMNS = "telegram_id AS telegramId, display_name AS displayName, role, timezone, student_enabled AS studentEnabled, teacher_enabled AS teacherEnabled, reminders_enabled AS remindersEnabled";
type ProfileRow = Omit<Profile, "studentEnabled" | "teacherEnabled" | "remindersEnabled"> & { studentEnabled: number, teacherEnabled: number, remindersEnabled: number };

export function readProfile(db: SqliteDatabase, telegramId: number): Profile | undefined {
  const row = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE telegram_id=?`).get(telegramId) as ProfileRow | undefined;
  return row && { ...row, studentEnabled: Boolean(row.studentEnabled), teacherEnabled: Boolean(row.teacherEnabled), remindersEnabled: Boolean(row.remindersEnabled) };
}

type Modes = Pick<Profile, "role" | "studentEnabled" | "teacherEnabled">;
const modeEnabled = (modes: Modes, role: ProfileRole) => role === "teacher" ? modes.teacherEnabled : modes.studentEnabled;

/**
 * The single source of the profile mode rules, applied to the merged profile:
 * - at least one of Student / Profesor stays enabled;
 * - an explicitly requested role must be an enabled mode;
 * - disabling the active mode (without choosing a role) switches to the other, enabled mode.
 */
export function resolveProfileModes(current: Modes, changes: ProfileChanges): Modes {
  const merged: Modes = {
    role: changes.role ?? current.role,
    studentEnabled: changes.studentEnabled ?? current.studentEnabled,
    teacherEnabled: changes.teacherEnabled ?? current.teacherEnabled
  };
  if (!merged.studentEnabled && !merged.teacherEnabled) throw new ProfileRuleError(PROFILE_MESSAGES.atLeastOneMode);
  if (!modeEnabled(merged, merged.role)) {
    if (changes.role) throw new ProfileRuleError(PROFILE_MESSAGES.modeDisabled(changes.role));
    merged.role = merged.role === "teacher" ? "student" : "teacher";
  }
  return merged;
}

/**
 * Applies profile changes atomically (read, validate and write in one SQLite transaction) and
 * returns the updated profile. The profile row must already exist (see `upsertProfile`).
 * Throws ProfileRuleError when the mode rules are violated; nothing is written in that case.
 */
export function updateProfile(db: SqliteDatabase, telegramId: number, changes: ProfileChanges): Profile {
  return db.transaction(() => {
    const current = readProfile(db, telegramId);
    if (!current) throw new Error(`Profile ${telegramId} does not exist`);
    const modes = resolveProfileModes(current, changes);
    const remindersEnabled = changes.remindersEnabled ?? current.remindersEnabled;
    db.prepare("UPDATE profiles SET role=?, student_enabled=?, teacher_enabled=?, reminders_enabled=? WHERE telegram_id=?")
      .run(modes.role, Number(modes.studentEnabled), Number(modes.teacherEnabled), Number(remindersEnabled), telegramId);
    return readProfile(db, telegramId) as Profile;
  }).immediate();
}
