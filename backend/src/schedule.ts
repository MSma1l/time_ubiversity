export type WeekKind = "odd" | "even" | "every";
/** A concrete week parity ("every" is a lesson rule, never a week's own parity). */
export type Parity = Exclude<WeekKind, "every">;

export const UNIVERSITY_TIMEZONE = "Europe/Chisinau";

/**
 * A teaching period: `start` is its first Monday, `kind` that week's parity and `end` its last day
 * (`null` = open-ended). Parity and week numbering restart at every semester, because the university
 * restarts the count after the winter break — a single global anchor would let the holidays consume
 * parity and invert it in the second semester.
 */
export type Semester = { start: string; kind: Parity; end: string | null };

/**
 * Default: exactly the behaviour shipped before semesters were configurable — one open-ended semester
 * anchored on the even week of 7–13 September 2026. The end is left `null` (instead of an invented
 * date) so that nothing becomes a non-teaching day for installations that configure nothing; real
 * semester ends belong in `SEMESTERS`, which only the university can fill in.
 */
export const DEFAULT_SEMESTERS: readonly Semester[] = [{ start: "2026-09-07", kind: "even", end: null }];

/** @deprecated Kept for callers that still show a single anchor; prefer `semesterOf` / `weekInfo`. */
export const SEMESTER_REFERENCE_MONDAY = DEFAULT_SEMESTERS[0].start;
export const SEMESTER_REFERENCE_KIND = DEFAULT_SEMESTERS[0].kind;

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

const otherParity = (kind: Parity): Parity => (kind === "even" ? "odd" : "even");

/** `SEMESTERS` text ("2026-09-07:even:2026-12-20,2027-02-08:even") → semesters + every problem found. */
export function parseSemesters(raw: string | undefined): { semesters: Semester[]; problems: string[] } {
  const problems: string[] = [];
  const text = (raw ?? "").trim();
  if (!text) return { semesters: [...DEFAULT_SEMESTERS], problems };
  const parsed: Semester[] = [];
  for (const entry of text.split(",").map((part) => part.trim()).filter(Boolean)) {
    const fields = entry.split(":").map((field) => field.trim());
    if (fields.length < 2 || fields.length > 3) {
      problems.push(`SEMESTERS: "${entry}" must be START:even|odd[:END] (dates as YYYY-MM-DD)`);
      continue;
    }
    const [start, kind, end = ""] = fields;
    if (!isValidIsoDate(start)) { problems.push(`SEMESTERS: "${start}" is not a valid YYYY-MM-DD date`); continue; }
    if (kind !== "odd" && kind !== "even") { problems.push(`SEMESTERS: "${kind}" must be "even" or "odd" (semester starting ${start})`); continue; }
    if (isoWeekday(start) !== 1) problems.push(`SEMESTERS: ${start} is not a Monday — a semester must start on the Monday of its first week`);
    if (end && !isValidIsoDate(end)) { problems.push(`SEMESTERS: "${end}" is not a valid YYYY-MM-DD date`); continue; }
    if (end && end < start) { problems.push(`SEMESTERS: the semester ${start} ends before it starts (${end})`); continue; }
    parsed.push({ start, kind, end: end || null });
  }
  if (!parsed.length && !problems.length) problems.push("SEMESTERS: at least one semester is required (or leave the variable empty)");
  const semesters = [...parsed].sort((a, b) => a.start.localeCompare(b.start));
  for (let index = 1; index < semesters.length; index += 1) {
    const previous = semesters[index - 1], current = semesters[index];
    // An open-ended semester swallows everything after it, so only the last one may omit its end.
    if (previous.end === null) problems.push(`SEMESTERS: the semester ${previous.start} has no end date, so it overlaps ${current.start}`);
    else if (current.start <= previous.end) problems.push(`SEMESTERS: the semesters ${previous.start} and ${current.start} overlap`);
  }
  // A rejected configuration still throws in loadConfig; the fallback only keeps pure helpers usable.
  return { semesters: problems.length ? [...DEFAULT_SEMESTERS] : semesters, problems };
}

let cached: { raw: string; semesters: Semester[] } | null = null;

/**
 * Semesters in force, from `SEMESTERS` (validated at startup by `loadConfig`). Read lazily and cached
 * per raw value so every pure helper keeps its one-argument signature and tests can swap the variable.
 */
export function activeSemesters(): Semester[] {
  const raw = process.env.SEMESTERS?.trim() ?? "";
  if (!cached || cached.raw !== raw) cached = { raw, semesters: parseSemesters(raw).semesters };
  return cached.semesters;
}

/** The semester containing the date, or null during a holiday / between semesters. */
export function semesterOf(isoDate: string, semesters: Semester[] = activeSemesters()): Semester | null {
  return semesters.find((semester) => isoDate >= semester.start && (semester.end === null || isoDate <= semester.end)) ?? null;
}

/**
 * Outside every semester the week number and parity are still defined — the calendar must show
 * something during the winter break — by extending the last semester that has already started
 * (or the first one, for dates before the academic year begins). Only `isTeachingDay` says whether
 * classes actually happen, so reminders stay silent while the UI keeps a stable parity.
 */
function anchorOf(isoDate: string, semesters: Semester[]): Semester {
  const started = semesters.filter((semester) => semester.start <= isoDate);
  return started.length ? started[started.length - 1] : semesters[0];
}

/** Week 1 is the semester's first week; weeks before its start are 0, -1, … */
export function universityWeekNumber(isoDate: string, semesters: Semester[] = activeSemesters()): number {
  const semester = anchorOf(isoDate, semesters);
  return Math.round((mondayOf(isoDate).getTime() - mondayOf(semester.start).getTime()) / (7 * DAY_MS)) + 1;
}

export function universityWeekKind(isoDate: string, semesters: Semester[] = activeSemesters()): Parity {
  const semester = anchorOf(isoDate, semesters);
  // Odd week numbers (1, 3, …) share the parity of the semester's first week.
  return Math.abs(universityWeekNumber(isoDate, semesters)) % 2 === 1 ? semester.kind : otherParity(semester.kind);
}

/** False during the summer holiday and between semesters: no lesson is held, so no reminder is due. */
export function isTeachingDay(isoDate: string, semesters: Semester[] = activeSemesters()): boolean {
  return semesterOf(isoDate, semesters) !== null;
}

export type WeekInfo = { date: string; number: number; kind: Parity; inSemester: boolean; semesterStart: string; semesterEnd: string | null };

/** Everything the clients need about one date's week (see GET /api/week). */
export function weekInfo(isoDate: string, semesters: Semester[] = activeSemesters()): WeekInfo {
  const anchor = anchorOf(isoDate, semesters);
  return {
    date: isoDate, number: universityWeekNumber(isoDate, semesters), kind: universityWeekKind(isoDate, semesters),
    inSemester: semesterOf(isoDate, semesters) !== null, semesterStart: anchor.start, semesterEnd: anchor.end
  };
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
 * Finds the lesson occurrence (yesterday, today or tomorrow, so reminders and their catch-up
 * window may cross midnight) whose reminder time was already reached but is still recoverable.
 * As long as the lesson has not started, the reminder may be caught up for as long as its own
 * lead time (a restart, a deploy or the missing hour of the spring DST change swallows whole
 * minutes, yet "În 6 minute" is still useful); once the lesson has started only `graceMinutes`
 * remain, so a `reminderMinutes = 0` reminder keeps its late window and nothing is ever
 * announced later than that. Duplicates are prevented by the caller. Minute arithmetic uses
 * Chisinau wall-clock time.
 */
export function dueReminderOccurrence(lesson: ReminderLesson, clock: LocalClock, graceMinutes = 5): { date: string; minutesUntilStart: number } | null {
  const start = timeToMinutes(lesson.startTime);
  const window = Math.max(graceMinutes, lesson.reminderMinutes);
  for (const offset of [-1, 0, 1]) {
    const date = addDays(clock.date, offset);
    if (isoWeekday(date) !== lesson.weekday || !appliesInWeek(lesson.weekKind, date)) continue;
    const minutesUntilStart = offset * 1440 + start - clock.minutes;
    // How late we are relative to the reminder moment; bounded to [0, window].
    const lateBy = lesson.reminderMinutes - minutesUntilStart;
    if (lateBy >= 0 && lateBy <= window && minutesUntilStart >= -graceMinutes) return { date, minutesUntilStart };
  }
  return null;
}

/**
 * Orthodox Easter (Meeus' Julian algorithm). The formula yields a date in the Julian calendar; the
 * Gregorian one runs 13 days ahead for 1900–2099, and Easter always falls in March/April, so the
 * shift can be applied directly to the same month/day. Verified: 2026-04-12, 2027-05-02, 2028-04-16.
 */
export function orthodoxEaster(year: number): string {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return addDays(julian, 13);
}

export type NonWorkingDay = { date: string; label: string };

/** Fixed-date public holidays of the Republic of Moldova (MM-DD). */
const FIXED_HOLIDAYS: Array<[string, string]> = [
  ["01-01", "Anul Nou"], ["01-07", "Crăciunul pe stil vechi"], ["01-08", "Crăciunul pe stil vechi"],
  ["03-08", "Ziua internațională a femeii"], ["05-01", "Ziua internațională a solidarității oamenilor muncii"],
  ["05-09", "Ziua Victoriei și a Europei"], ["06-01", "Ziua ocrotirii copilului"],
  ["08-27", "Ziua Independenței"], ["08-31", "Limba noastră"], ["12-25", "Crăciunul pe stil nou"]
];

/** Every public holiday of one calendar year, fixed and Easter-based, sorted by date. */
export function legalHolidays(year: number): NonWorkingDay[] {
  const easter = orthodoxEaster(year);
  const days = [
    ...FIXED_HOLIDAYS.map(([monthDay, label]) => ({ date: `${year}-${monthDay}`, label })),
    { date: addDays(easter, 1), label: "Paștele" },
    { date: addDays(easter, 2), label: "A doua zi de Paște" },
    // Eight days after Easter: the Monday following Duminica Tomii.
    { date: addDays(easter, 8), label: "Paștele Blajinilor" }
  ];
  return days.sort((first, second) => first.date.localeCompare(second.date));
}
