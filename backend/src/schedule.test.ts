import { describe, expect, it } from "vitest";
import { addDays, appliesInWeek, chisinauClock, dueReminderOccurrence, isTeachingDay, isValidIsoDate, isoWeekday, legalHolidays, orthodoxEaster, parseSemesters, semesterOf, universityWeekKind, universityWeekNumber, weekInfo, type Semester } from "./schedule.js";

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
  it("is due from start minus reminder until the lesson starts, never before or after", () => {
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 44 })).toBeNull();
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 45 })).toEqual({ date: "2026-09-14", minutesUntilStart: 15 });
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 50 })).toEqual({ date: "2026-09-14", minutesUntilStart: 10 });
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 8 * 60 })).toEqual({ date: "2026-09-14", minutesUntilStart: 0 });
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 8 * 60 + 1 })).toBeNull();
  });
  it("recovers a reminder missed while the process was down, as long as the lesson has not started", () => {
    // The cron stopped at 07:44 (before the 07:45 reminder) and comes back ten minutes later.
    expect(dueReminderOccurrence(lesson, { ...monday, minutes: 7 * 60 + 54 })).toEqual({ date: "2026-09-14", minutesUntilStart: 6 });
    // A two-hour lead time is recovered the same way, but never past the start time.
    const early = { ...lesson, reminderMinutes: 120 };
    expect(dueReminderOccurrence(early, { ...monday, minutes: 7 * 60 + 30 })).toEqual({ date: "2026-09-14", minutesUntilStart: 30 });
    expect(dueReminderOccurrence(early, { ...monday, minutes: 5 * 60 + 59 })).toBeNull();
    expect(dueReminderOccurrence(early, { ...monday, minutes: 8 * 60 + 1 })).toBeNull();
  });
  it("recovers reminders swallowed by the missing hour of the spring DST change", () => {
    // Sunday 28 March 2027: Chisinau jumps from 01:59 to 03:00, so 02:45 (the reminder of a 03:00
    // lesson) never happens on the wall clock. The first tick after the jump must still deliver it.
    const sunday = { weekday: 7, startTime: "03:00", weekKind: "every" as const, reminderMinutes: 15 };
    const beforeJump = chisinauClock(new Date("2027-03-27T23:59:00Z"));
    const afterJump = chisinauClock(new Date("2027-03-28T00:00:00Z"));
    expect([beforeJump.date, beforeJump.minutes]).toEqual(["2027-03-28", 119]);
    expect([afterJump.date, afterJump.minutes]).toEqual(["2027-03-28", 180]);
    expect(dueReminderOccurrence(sunday, beforeJump)).toBeNull();
    expect(dueReminderOccurrence(sunday, afterJump)).toEqual({ date: "2027-03-28", minutesUntilStart: 0 });
    // A 03:10 lesson (reminder due at 02:55) is recovered too, still before it starts.
    const later = { ...sunday, startTime: "03:10" };
    expect(dueReminderOccurrence(later, chisinauClock(new Date("2027-03-28T00:01:00Z")))).toEqual({ date: "2027-03-28", minutesUntilStart: 9 });
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

describe("configurable semesters", () => {
  const twoSemesters: Semester[] = [
    { start: "2026-09-07", kind: "even", end: "2026-12-20" },
    { start: "2027-02-01", kind: "even", end: "2027-05-30" }
  ];
  it("restarts numbering and parity at the second semester", () => {
    expect(universityWeekNumber("2026-09-07", twoSemesters)).toBe(1);
    expect(universityWeekKind("2026-12-14", twoSemesters)).toBe("even");
    // Without a restart the winter break would have consumed the parity: the same day is "odd" then.
    expect(universityWeekKind("2027-02-01")).toBe("odd");
    expect(universityWeekNumber("2027-02-01", twoSemesters)).toBe(1);
    expect(universityWeekKind("2027-02-01", twoSemesters)).toBe("even");
    expect(universityWeekKind("2027-02-08", twoSemesters)).toBe("odd");
  });
  it("keeps a defined week outside every semester, but marks it as non-teaching", () => {
    expect(isTeachingDay("2026-10-05", twoSemesters)).toBe(true);
    for (const day of ["2026-08-24", "2027-01-15", "2027-07-01"]) expect(isTeachingDay(day, twoSemesters)).toBe(false);
    expect(semesterOf("2027-01-15", twoSemesters)).toBeNull();
    // The winter break keeps counting the first semester, so the calendar still shows a parity.
    expect(universityWeekNumber("2027-01-15", twoSemesters)).toBe(19);
    expect(universityWeekKind("2027-01-15", twoSemesters)).toBe("even");
    expect(weekInfo("2027-01-15", twoSemesters)).toEqual({ date: "2027-01-15", number: 19, kind: "even", inSemester: false, semesterStart: "2026-09-07", semesterEnd: "2026-12-20" });
    expect(weekInfo("2026-08-24", twoSemesters).semesterStart).toBe("2026-09-07");
  });
  it("defaults to the historical single anchor and reads SEMESTERS from the environment", () => {
    expect(parseSemesters(undefined)).toEqual({ semesters: [{ start: "2026-09-07", kind: "even", end: null }], problems: [] });
    expect(parseSemesters("  ").semesters).toEqual([{ start: "2026-09-07", kind: "even", end: null }]);
    expect(isTeachingDay("2030-01-01")).toBe(true); // open-ended default: nothing becomes a holiday
    const previous = process.env.SEMESTERS;
    try {
      process.env.SEMESTERS = "2026-09-07:even:2026-12-20,2027-02-01:even:2027-05-30";
      expect(universityWeekKind("2027-02-01")).toBe("even");
      expect(isTeachingDay("2027-01-15")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SEMESTERS; else process.env.SEMESTERS = previous;
    }
    expect(universityWeekKind("2027-02-01")).toBe("odd");
  });
  it("reports every problem and sorts the semesters it accepts", () => {
    expect(parseSemesters("2027-02-01:even,2026-09-07:even:2026-12-20").semesters.map((item) => item.start)).toEqual(["2026-09-07", "2027-02-01"]);
    expect(parseSemesters("2026-09-08:even").problems).toEqual([expect.stringContaining("not a Monday")]);
    expect(parseSemesters("2026-09-07:even:2026-08-01").problems).toEqual([expect.stringContaining("ends before it starts")]);
    expect(parseSemesters("2026-09-07:even:2027-03-01,2027-02-01:odd").problems).toEqual([expect.stringContaining("overlap")]);
    expect(parseSemesters("2026-09-07:odd,2027-02-01:odd").problems).toEqual([expect.stringContaining("no end date")]);
    expect(parseSemesters("2026-09-07:para").problems).toEqual([expect.stringContaining('"para"')]);
    expect(parseSemesters("nonsense").problems.length).toBeGreaterThan(0);
    // A rejected value never changes the parity: loadConfig throws, the helpers keep the default.
    expect(parseSemesters("nonsense").semesters).toEqual([{ start: "2026-09-07", kind: "even", end: null }]);
  });
});

describe("Moldovan public holidays", () => {
  it("computes Orthodox Easter", () => {
    expect(orthodoxEaster(2026)).toBe("2026-04-12");
    expect(orthodoxEaster(2027)).toBe("2027-05-02");
    expect(orthodoxEaster(2028)).toBe("2028-04-16");
  });
  it("lists the fixed and the Easter-based days of a year", () => {
    const days = legalHolidays(2026);
    const dates = days.map((day) => day.date);
    expect(dates).toContain("2026-01-01");
    expect(dates).toContain("2026-08-27");
    expect(dates).toContain("2026-12-25");
    expect(dates).toEqual([...dates].sort());
    // Easter 2026 is 12 April: Monday and Tuesday after it, then Blajinii a week later.
    expect(dates).toContain("2026-04-13");
    expect(dates).toContain("2026-04-14");
    expect(days.find((day) => day.date === "2026-04-20")?.label).toBe("Paștele Blajinilor");
    expect(days.every((day) => day.label.length > 0)).toBe(true);
  });
});
