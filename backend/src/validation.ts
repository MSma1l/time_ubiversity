import { z } from "zod";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Trimmed single-line text without control characters. */
export const text = (min: number, max: number) => z.string().trim().min(min).max(max)
  .refine((value) => !CONTROL_CHARACTERS.test(value), { message: "Textul conține caractere nepermise" });

/** Optional text where an empty string is stored as null. */
const optionalText = (max: number) => text(0, max).nullable().optional().transform((value) => (value ? value : null));

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ora trebuie să fie în format HH:MM");

export const lessonSchema = z.object({
  role: z.enum(["student", "teacher"]), title: text(1, 120),
  groupName: optionalText(80), teacherName: optionalText(100), room: optionalText(60),
  weekday: z.number().int().min(1).max(7), startTime: time, endTime: time,
  weekKind: z.enum(["odd", "even", "every"]), reminderMinutes: z.number().int().min(0).max(180), notificationsEnabled: z.boolean()
}).refine((item) => item.endTime > item.startTime, { message: "Ora de final trebuie să fie după ora de început", path: ["endTime"] });

export const profilePatchSchema = z.object({
  role: z.enum(["student", "teacher"]).optional(), studentEnabled: z.boolean().optional(), teacherEnabled: z.boolean().optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), { message: "Nicio modificare trimisă" });

export const lessonIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const uuidSchema = z.uuid();

export const groupSchema = z.object({ name: text(2, 80), subject: optionalText(120) });
export const studentSchema = z.object({ firstName: text(1, 80), lastName: text(1, 80) });
export const attendanceSchema = z.object({
  date: z.iso.date(), topic: optionalText(160),
  entries: z.array(z.object({ studentId: z.uuid(), status: z.enum(["present", "absent", "late"]) })).max(500)
});
export const gradeSchema = z.object({
  laboratory: text(1, 120), grade: z.number().min(0).max(10),
  presentedOn: z.iso.date().optional(), feedback: z.string().trim().max(500).optional().transform((value) => (value ? value : null))
});
