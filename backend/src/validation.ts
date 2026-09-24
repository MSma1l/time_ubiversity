import { z } from "zod";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Trimmed single-line text without control characters. Messages are user-facing Romanian. */
export const text = (min: number, max: number) => z.string({ error: "Trebuie să fie text" }).trim()
  .min(min, { error: min <= 1 ? "Câmpul este obligatoriu" : `Minimum ${min} caractere` })
  .max(max, { error: `Maximum ${max} caractere` })
  .refine((value) => !CONTROL_CHARACTERS.test(value), { message: "Textul conține caractere nepermise" });

/** Optional text where an empty string is stored as null. */
const optionalText = (max: number) => text(0, max).nullable().optional().transform((value) => (value ? value : null));

/**
 * Lesson time. Accepts what time inputs produce on every platform ("9:30", "09:30", "09:30:00")
 * and normalises it to zero-padded "HH:MM", so string comparison and reminders stay correct.
 */
const TIME_INPUT = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?$/;
const time = z.string({ error: "Ora trebuie să fie în format HH:MM" }).trim()
  .refine((value) => { const match = TIME_INPUT.exec(value); return Boolean(match && Number(match[1]) < 24); }, { message: "Ora trebuie să fie în format HH:MM" })
  .transform((value) => { const [hour, minute] = value.split(":"); return `${hour.padStart(2, "0")}:${minute}`; });

export const LESSON_ROLES = ["student", "teacher"] as const;
const role = z.enum(LESSON_ROLES, { error: "Rolul trebuie să fie student sau profesor" });

const lessonFields = {
  role, title: text(1, 120),
  groupName: optionalText(80), teacherName: optionalText(100), room: optionalText(60),
  weekday: z.number({ error: "Alege ziua" }).int({ error: "Alege ziua" }).min(1, { error: "Ziua trebuie să fie între 1 și 7" }).max(7, { error: "Ziua trebuie să fie între 1 și 7" }),
  startTime: time, endTime: time,
  weekKind: z.enum(["odd", "even", "every"], { error: "Alege săptămâna: pară, impară sau în fiecare" }),
  reminderMinutes: z.number({ error: "Memento invalid" }).int({ error: "Memento invalid" }).min(0, { error: "Memento-ul poate fi între 0 și 180 de minute" }).max(180, { error: "Memento-ul poate fi între 0 și 180 de minute" }),
  notificationsEnabled: z.boolean({ error: "Memento invalid" })
};
const endAfterStart = { message: "Ora de final trebuie să fie după ora de început", path: ["endTime"] };
/** Compared only when both times are valid, so a bad start time does not also report the end time. */
const NORMALISED_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const endsAfterStart = (item: { startTime: string, endTime: string }) =>
  !NORMALISED_TIME.test(item.startTime) || !NORMALISED_TIME.test(item.endTime) || item.endTime > item.startTime;

/** POST /api/lessons: the role is required — Student and Profesor schedules are separate lists. */
export const lessonSchema = z.object(lessonFields).refine(endsAfterStart, endAfterStart);
/** PUT /api/lessons/:id: omitting `role` keeps the lesson in its current schedule. */
export const lessonUpdateSchema = z.object({ ...lessonFields, role: role.optional() }).refine(endsAfterStart, endAfterStart);

export const profilePatchSchema = z.object({
  role: role.optional(), studentEnabled: z.boolean().optional(), teacherEnabled: z.boolean().optional(),
  remindersEnabled: z.boolean({ error: "Valoare invalidă pentru memento-uri" }).optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), { message: "Nicio modificare trimisă" });

export const notificationsReadSchema = z.object({ role: role.optional() }).optional();

export const lessonIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const uuidSchema = z.uuid();

/** Calendar date accepted by PostgreSQL and meaningful for a university catalog (years 2000–2100). */
export const catalogDateSchema = z.iso.date({ error: "Data trebuie să fie în format YYYY-MM-DD" })
  .refine((value) => { const year = Number(value.slice(0, 4)); return year >= 2000 && year <= 2100; }, { message: "Anul trebuie să fie între 2000 și 2100" });

const atLeastOne = { message: "Nicio modificare trimisă" };
const hasChanges = (value: object) => Object.values(value).some((item) => item !== undefined);

/** GET /api/teacher/groups/:groupId/attendance?date=YYYY-MM-DD (optional). */
export const attendanceQuerySchema = z.object({ date: catalogDateSchema.optional() });

export const groupSchema = z.object({ name: text(2, 80), subject: optionalText(120) });
/** PATCH /api/teacher/groups/:groupId — `subject: null` or "" clears the subject. */
export const groupPatchSchema = z.object({
  name: text(2, 80).optional(),
  subject: text(0, 120).nullable().optional().transform((value) => (value === undefined ? undefined : value || null))
}).refine(hasChanges, atLeastOne);
export const studentSchema = z.object({ firstName: text(1, 80), lastName: text(1, 80) });
export const studentPatchSchema = z.object({ firstName: text(1, 80).optional(), lastName: text(1, 80).optional() }).refine(hasChanges, atLeastOne);
/** POST /api/teacher/groups/:groupId/attendance — a missing `topic` keeps the saved one, `null` or "" clears it. */
export const attendanceSchema = z.object({
  date: catalogDateSchema,
  topic: text(0, 160).nullable().optional().transform((value) => (value === undefined ? undefined : value || null)),
  entries: z.array(z.object({ studentId: z.uuid(), status: z.enum(["present", "absent", "late"]) })).max(500)
});
export const gradeSchema = z.object({
  laboratory: text(1, 120), grade: z.number().min(0).max(10),
  presentedOn: catalogDateSchema.optional(), feedback: optionalText(500)
});
/** The next laboratory number is assigned atomically by the server. */
export const laboratorySchema = z.object({}).strict();

/**
 * GET /api/non-working-days?from=…&to=… — a closed interval, at most `MAX_RANGE_DAYS` long (a bit more
 * than an academic year): the calendar never paints more, and one request cannot make the server walk
 * a century. Only reading is validated here — writing free days is not an API operation (see app.ts).
 */
const MAX_RANGE_DAYS = 400;
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
export const nonWorkingRangeSchema = z.object({ from: catalogDateSchema, to: catalogDateSchema })
  .refine((value) => value.to >= value.from, { message: "Intervalul se termină înainte să înceapă", path: ["to"] })
  .refine((value) => daysBetween(value.from, value.to) <= MAX_RANGE_DAYS, { message: `Intervalul poate acoperi cel mult ${MAX_RANGE_DAYS} de zile`, path: ["to"] });
