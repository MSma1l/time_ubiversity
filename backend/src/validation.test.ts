import { describe, expect, it } from "vitest";
import { attendanceSchema, gradeSchema, groupSchema, lessonIdSchema, lessonSchema, lessonUpdateSchema, profilePatchSchema, studentSchema } from "./validation.js";

const lesson = { role: "student", title: "Matematică", groupName: "", teacherName: null, room: " 3-101 ", weekday: 1, startTime: "08:00", endTime: "09:30", weekKind: "every", reminderMinutes: 15, notificationsEnabled: true };

describe("lessonSchema", () => {
  it("accepts the payload sent by the Mini App and normalises empty text to null", () => {
    expect(lessonSchema.parse(lesson)).toMatchObject({ groupName: null, teacherName: null, room: "3-101" });
  });
  it("rejects bad times, reversed intervals, bad weekdays and oversized text", () => {
    expect(lessonSchema.safeParse({ ...lesson, startTime: "24:00" }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, endTime: "07:00" }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, weekday: 0 }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, title: "x".repeat(121) }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, title: "   " }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, title: "a\u0007b" }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, reminderMinutes: 181 }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, weekKind: "both" }).success).toBe(false);
    expect(lessonSchema.safeParse({ ...lesson, weekday: "1" }).success).toBe(false);
  });
});

describe("lessonUpdateSchema", () => {
  it("allows omitting the role (kept by the server) but still rejects unknown roles", () => {
    const { role: _role, ...withoutRole } = lesson;
    expect(lessonUpdateSchema.parse(withoutRole).role).toBeUndefined();
    expect(lessonUpdateSchema.safeParse({ ...lesson, role: "admin" }).success).toBe(false);
    expect(lessonUpdateSchema.parse({ ...lesson, startTime: "8:05", endTime: "08:50:00" })).toMatchObject({ startTime: "08:05", endTime: "08:50" });
  });
});

describe("other schemas", () => {
  it("profile patch needs at least one known field", () => {
    expect(profilePatchSchema.safeParse({}).success).toBe(false);
    expect(profilePatchSchema.safeParse({ admin: true }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ role: "teacher" }).success).toBe(true);
    expect(profilePatchSchema.safeParse({ role: "admin" }).success).toBe(false);
  });
  it("lesson ids are positive integers", () => {
    expect(lessonIdSchema.parse("12")).toBe(12);
    expect(lessonIdSchema.safeParse("-1").success).toBe(false);
    expect(lessonIdSchema.safeParse("1.5").success).toBe(false);
    expect(lessonIdSchema.safeParse("abc").success).toBe(false);
  });
  it("catalog schemas enforce lengths, dates, uuids and grade range", () => {
    expect(groupSchema.parse({ name: "TI-241", subject: "" })).toEqual({ name: "TI-241", subject: null });
    expect(groupSchema.safeParse({ name: "T" }).success).toBe(false);
    expect(studentSchema.safeParse({ firstName: "Ana", lastName: "x".repeat(81) }).success).toBe(false);
    expect(attendanceSchema.safeParse({ date: "2026-02-30", entries: [] }).success).toBe(false);
    expect(attendanceSchema.safeParse({ date: "2026-09-14", entries: [{ studentId: "not-a-uuid", status: "present" }] }).success).toBe(false);
    expect(attendanceSchema.safeParse({ date: "2026-09-14", entries: [{ studentId: "0b6e3f8e-1111-4111-8111-111111111111", status: "late" }] }).success).toBe(true);
    expect(gradeSchema.safeParse({ laboratory: "Lab 1", grade: 10.5 }).success).toBe(false);
    expect(gradeSchema.safeParse({ laboratory: "Lab 1", grade: 9.5, presentedOn: "2026-09-14" }).success).toBe(true);
  });
});
