import { describe, expect, it } from "vitest";
import { addDays, appliesInWeek, chisinauClock, dueReminderOccurrence, isValidIsoDate, isoWeekday, universityWeekKind, universityWeekNumber } from "./schedule.js";

describe("university week cycle", () => {
  it("uses 7–13 September 2026 as even", () => {
    for (const day of ["2026-09-07", "2026-09-10", "2026-09-13"]) {
      expect(universityWeekNumber(day)).toBe(1);
      expect(universityWeekKind(day)).toBe("even");
    }
    expect(universityWeekKind("2026-09-14")).toBe("odd");
    expect(universityWeekKind("2026-09-20")).toBe("odd");
    expect(universityWeekKind("2026-09-21")).toBe("even");
  });
  it("keeps alternating before the reference week and across year/DST boundaries", () => {
    expect(universityWeekKind("2026-09-06")).toBe("odd");
    expect(universityWeekKind("2026-08-31")).toBe("odd");
    expect(universityWeekKind("2026-08-24")).toBe("even");
    // 25 Oct 2026 is the DST change in Chisinau; 26 Oct is week 8.
    expect(universityWeekNumber("2026-10-26")).toBe(8);
    expect(universityWeekKind("2026-10-26")).toBe("odd");
    expect(universityWeekNumber("2027-03-29")).toBe(30);
    expect(universityWeekKind("2027-03-29")).toBe("odd");
    expect(universityWeekNumber("2027-01-04")).toBe(18);
  });
  it("matches every and the matching parity", () => {
    expect(appliesInWeek("every", "2026-09-14")).toBe(true);
    expect(appliesInWeek("odd", "2026-09-14")).toBe(true);
    expect(appliesInWeek("even", "2026-09-14")).toBe(false);
  });
});

describe("date helpers", () => {
  it("validates real calendar dates only", () => {
    expect(isValidIsoDate("2026-09-14")).toBe(true);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-9-1")).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });
  it("computes weekdays and adds days", () => {
    expect(isoWeekday("2026-09-13")).toBe(7);
    expect(isoWeekday("2026-09-14")).toBe(1);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("reads the Chisinau wall clock (UTC+3 in summer, UTC+2 in winter)", () => {
    expect(chisinauClock(new Date("2026-09-13T21:30:00Z"))).toEqual({ date: "2026-09-14", weekday: 1, minutes: 30 });
    expect(chisinauClock(new Date("2026-12-01T22:05:00Z"))).toEqual({ date: "2026-12-02", weekday: 3, minutes: 5 });
  });
});

describe("reminder due time", () => {
  const monday = { date: "2026-09-14", weekday: 1 }; // odd week
  const lesson = { weekday: 1, startTime: "08:00", weekKind: "every" as const, reminderMinutes: 15 };
  it("is due exactly at start minus reminder and within the grace window", () => {
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 44 })).toBeNull();
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 45 })).toEqual({ date: "2026-09-14", minutesUntilStart: 15 });
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 50 })).toEqual({ date: "2026-09-14", minutesUntilStart: 10 });
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 51 })).toBeNull();
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 8 * 60 + 1 })).toBeNull();
  });
  it("respects week parity", () => {
    expect(dueReminderOccurrence({ ...lesson, weekKind: "even" }, { ...monday, minutes: 7 * 60 + 45 })).toBeNull();
    expect(dueReminderOccurrence({ ...lesson, weekKind: "odd" }, { ...monday, minutes: 7 * 60 + 45 })).not.toBeNull();
  });
  it("crosses midnight using the parity of the lesson day", () => {
    // Sunday 13 Sept (even week) 23:30 → Monday 14 Sept (odd week) 00:30 lesson, 60 min reminder.
    const early = { weekday: 1, startTime: "00:30", weekKind: "odd" as const, reminderMinutes: 60 };
    expect(dueReminderOccurrence(early, { date: "2026-09-13", weekday: 7, minutes: 23 * 60 + 30 })).toEqual({ date: "2026-09-14", minutesUntilStart: 60 });
    expect(dueReminderOccurrence({ ...early, weekKind: "even" }, { date: "2026-09-13", weekday: 7, minutes: 23 * 60 + 30 })).toBeNull();
  });
  it("supports a reminder at the start time", () => {
    expect(dueReminderOccurrence({ ...lesson, reminderMinutes: 0 }, { ...monday, minutes: 8 * 60 })).toEqual({ date: "2026-09-14", minutesUntilStart: 0 });
  });
  it("gives a start-time reminder the same grace window, never later", () => {
    const atStart = { ...lesson, reminderMinutes: 0 };
    expect(dueReminderOccurrence(atStart, { ...monday, minutes: 7 * 60 + 59 })).toBeNull();
    expect(dueReminderOccurrence(atStart, { ...monday, minutes: 8 * 60 + 3 })).toEqual({ date: "2026-09-14", minutesUntilStart: -3 });
    expect(dueReminderOccurrence(atStart, { ...monday, minutes: 8 * 60 + 5 })).toEqual({ date: "2026-09-14", minutesUntilStart: -5 });
    expect(dueReminderOccurrence(atStart, { ...monday, minutes: 8 * 60 + 6 })).toBeNull();
    // A 23:58 Sunday lesson (even week) is still catchable just after midnight.
    const late = { weekday: 7, startTime: "23:58", weekKind: "even" as const, reminderMinutes: 0 };
    expect(dueReminderOccurrence(late, { ...monday, minutes: 2 })).toEqual({ date: "2026-09-13", minutesUntilStart: -4 });
    expect(dueReminderOccurrence(late, { ...monday, minutes: 4 })).toBeNull();
  });
});
