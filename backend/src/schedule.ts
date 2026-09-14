export type WeekKind = "odd" | "even" | "every";

export const UNIVERSITY_TIMEZONE = "Europe/Chisinau";

/**
 * The university's reference: 7–13 September 2026 is the even week.
 * Weeks start on Monday in the Europe/Chisinau timetable convention.
 */
export const SEMESTER_REFERENCE_MONDAY = "2026-09-07";
export const SEMESTER_REFERENCE_KIND = "even";

const DAY_MS = 86_400_000;

/** Strict YYYY-MM-DD check that also rejects impossible dates such as 2026-02-30. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export type LocalClock = { date: string; weekday: number; minutes: number };

/** Wall-clock date, ISO weekday (1 = Monday … 7 = Sunday) and minutes since midnight in Chisinau. */
export function chisinauClock(now = new Date()): LocalClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UNIVERSITY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const value = (name: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === name)?.value ?? "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  return { date, weekday: isoWeekday(date), minutes: (Number(value("hour")) % 24) * 60 + Number(value("minute")) };
}

export function isoDateInChisinau(date = new Date()): string {
  return chisinauClock(date).date;
}

function noonUtc(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

export function isoWeekday(isoDate: string): number {
  const day = noonUtc(isoDate).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(noonUtc(isoDate).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function mondayOf(isoDate: string): Date {
  const date = noonUtc(isoDate);
  date.setUTCDate(date.getUTCDate() - (isoWeekday(isoDate) - 1));
  return date;
}

/** Week 1 is the reference week (7–13 Sept 2026); weeks before it are 0, -1, … */
export function universityWeekNumber(isoDate: string): number {
  const reference = mondayOf(SEMESTER_REFERENCE_MONDAY).getTime();
  const current = mondayOf(isoDate).getTime();
  return Math.round((current - reference) / (7 * DAY_MS)) + 1;
}

export function universityWeekKind(isoDate: string): Exclude<WeekKind, "every"> {
  // Odd week numbers (1, 3, …) share the parity of the reference week, which is even.
  return Math.abs(universityWeekNumber(isoDate)) % 2 === 1 ? SEMESTER_REFERENCE_KIND : "odd";
}

export function appliesInWeek(weekKind: WeekKind, isoDate: string): boolean {
  return weekKind === "every" || weekKind === universityWeekKind(isoDate);
}

export function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export type ReminderLesson = { weekday: number; startTime: string; weekKind: WeekKind; reminderMinutes: number };

/**
 * Finds the lesson occurrence (yesterday, today or tomorrow, so reminders and their grace
 * window may cross midnight) whose reminder time was reached within the last `graceMinutes`.
 * Every reminder gets the same window, including `reminderMinutes = 0`: a reminder at the
 * start time may still be delivered up to `graceMinutes` after the lesson began, never later.
 * Duplicates are prevented by the caller. Minute arithmetic uses Chisinau wall-clock time.
 */
export function dueReminderOccurrence(lesson: ReminderLesson, clock: LocalClock, graceMinutes = 5): { date: string; minutesUntilStart: number } | null {
  const start = timeToMinutes(lesson.startTime);
  for (const offset of [-1, 0, 1]) {
    const date = addDays(clock.date, offset);
    if (isoWeekday(date) !== lesson.weekday || !appliesInWeek(lesson.weekKind, date)) continue;
    const minutesUntilStart = offset * 1440 + start - clock.minutes;
    // How late we are relative to the reminder moment; bounded to [0, grace].
    const lateBy = lesson.reminderMinutes - minutesUntilStart;
    if (lateBy >= 0 && lateBy <= graceMinutes) return { date, minutesUntilStart };
  }
  return null;
}
