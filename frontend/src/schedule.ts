import type { Lesson, WeekType } from './types'

/** All schedule logic follows the university's local time, independent of the device time zone. */
export const UNIVERSITY_TIME_ZONE = 'Europe/Chisinau'
const DAY_MS = 86_400_000

/**
 * A teaching period: `start` is its first Monday, `kind` that week's parity and `end` its last day
 * (`null` = open-ended). Parity and week numbering restart at every semester — mirrors `Semester`
 * in backend/src/schedule.ts.
 */
export type Semester = { start: string, kind: WeekType, end: string | null }

/**
 * Identical to `DEFAULT_SEMESTERS` in backend/src/schedule.ts: one open-ended semester anchored on the
 * even week of 7–13 September 2026. Demo mode and the moments before `GET /api/week` answers run on it,
 * so it has to match the server's own default exactly.
 */
export const DEFAULT_SEMESTERS: readonly Semester[] = [{ start: '2026-09-07', kind: 'even', end: null }]

export const weekdayNames = ['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă', 'Duminică']
/** Calendar grid columns (Monday–Saturday); Sunday is added only when it has lessons. Day tabs and the editor use all of `weekdayNames`. */
export const teachingDays = weekdayNames.slice(0, 6)

/** Demo data — only used when the app runs in explicit demo mode (dev server or VITE_DEMO_MODE=true). */
export const demoLessons: Lesson[] = [
  { id: 'demo-1', role: 'student', title: 'Programare orientată pe obiecte', group: 'FAF-241', teacher: 'D. Rusu', room: '213/4', weekday: 0, startTime: '08:00', endTime: '09:30', weekType: 'both', reminderMinutes: 20, notificationsEnabled: true },
  { id: 'demo-2', role: 'student', title: 'Baze de date', group: 'FAF-241', teacher: 'S. Ceban', room: '305/4', weekday: 1, startTime: '09:45', endTime: '11:15', weekType: 'odd', reminderMinutes: 15, notificationsEnabled: true },
  { id: 'demo-3', role: 'student', title: 'Inteligență artificială', group: 'FAF-241', teacher: 'A. Popa', room: '214/4', weekday: 1, startTime: '11:30', endTime: '13:00', weekType: 'even', reminderMinutes: 15, notificationsEnabled: true },
  { id: 'demo-4', role: 'teacher', title: 'Rețele de calculatoare', group: 'SI-265 PC', teacher: 'D. Turcan', room: '401/4', weekday: 2, startTime: '11:30', endTime: '13:00', weekType: 'both', reminderMinutes: 15, notificationsEnabled: true },
  { id: 'demo-5', role: 'teacher', title: 'Ingineria programării', group: 'SI-265 PC', teacher: 'D. Turcan', room: '108/4', weekday: 3, startTime: '13:30', endTime: '15:00', weekType: 'both', reminderMinutes: 15, notificationsEnabled: true },
]

export type UniversityClock = {
  /** Calendar date in Europe/Chisinau, `YYYY-MM-DD`. */
  isoDate: string
  /** 0 = Monday … 6 = Sunday. */
  weekdayIndex: number
  /** Minutes since local midnight. */
  minutes: number
}

const clockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: UNIVERSITY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

const noonUtc = (isoDate: string) => new Date(`${isoDate}T12:00:00Z`)

/**
 * Dev-only clock override for manual testing, e.g. `?now=2026-09-20T23:58:00%2B03:00`. The clock keeps ticking from that instant.
 * `import.meta.env.DEV` is false in production builds, so the override is removed there.
 */
const devClockOffsetMs = (() => {
  if (!import.meta.env?.DEV || typeof window === 'undefined') return 0
  const value = new URLSearchParams(window.location.search).get('now')
  const time = value ? new Date(value).getTime() : Number.NaN
  return Number.isNaN(time) ? 0 : time - Date.now()
})()

/** Current instant (honours the dev clock override). */
export const currentInstant = () => new Date(Date.now() + devClockOffsetMs)

export function universityClock(date = currentInstant()): UniversityClock {
  const parts = clockFormatter.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00'
  const isoDate = `${value('year')}-${value('month')}-${value('day')}`
  return { isoDate, weekdayIndex: weekdayIndexOf(isoDate), minutes: Number(value('hour')) * 60 + Number(value('minute')) }
}

export function weekdayIndexOf(isoDate: string) {
  return (noonUtc(isoDate).getUTCDay() + 6) % 7
}

export function addDays(isoDate: string, days: number) {
  return new Date(noonUtc(isoDate).getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function formatDayMonth(isoDate: string) {
  return noonUtc(isoDate).toLocaleDateString('ro-RO', { timeZone: 'UTC', day: 'numeric', month: 'long' })
}

/** Monday (`YYYY-MM-DD`) of the week `weekOffset` weeks away from the week containing `isoDate`. */
export function mondayOf(isoDate: string, weekOffset = 0) {
  return addDays(isoDate, weekOffset * 7 - weekdayIndexOf(isoDate))
}

/** "7–13 septembrie", or "28 sept. – 4 oct." when the week spans two months. */
export function formatWeekRange(monday: string) {
  const sunday = addDays(monday, 6)
  const month = (isoDate: string, style: 'long' | 'short') => noonUtc(isoDate).toLocaleDateString('ro-RO', { timeZone: 'UTC', month: style })
  if (monday.slice(0, 7) === sunday.slice(0, 7)) return `${dayOfMonth(monday)}–${dayOfMonth(sunday)} ${month(monday, 'long')}`
  return `${dayOfMonth(monday)} ${month(monday, 'short')} – ${dayOfMonth(sunday)} ${month(sunday, 'short')}`
}

export const weekTypeLabels: Record<WeekType, string> = { even: 'pară', odd: 'impară' }

export function dayOfMonth(isoDate: string) {
  return Number(isoDate.slice(8, 10))
}

/** Strict `YYYY-MM-DD` check that also rejects impossible dates such as 2026-02-30. Mirrors the backend. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Semesters in force. Module state (not a prop) because parity is needed everywhere; see `installSemesters`. */
let semesters: Semester[] = [...DEFAULT_SEMESTERS]

/** The calendar the app is currently computing with — the default until `GET /api/week` answers. */
export const activeSemesters = (): Semester[] => semesters

/**
 * Installs the calendar received from the server and returns what was applied. An empty or unusable list
 * keeps the default, so a broken response can never leave the app without a parity. Callers must also put
 * the result in React state: parity is read during render and nothing else would trigger a re-render.
 */
export function installSemesters(list: readonly Semester[] | null | undefined): Semester[] {
  const valid = (list ?? [])
    .filter((item): item is Semester => Boolean(item) && isValidIsoDate(item.start) && (item.kind === 'even' || item.kind === 'odd') && (item.end === null || isValidIsoDate(item.end)))
    .map((item) => ({ start: item.start, kind: item.kind, end: item.end ?? null }))
    .sort((a, b) => a.start.localeCompare(b.start))
  semesters = valid.length ? valid : [...DEFAULT_SEMESTERS]
  return semesters
}

const otherWeekType = (kind: WeekType): WeekType => kind === 'even' ? 'odd' : 'even'
const mondayTime = (isoDate: string) => noonUtc(isoDate).getTime() - weekdayIndexOf(isoDate) * DAY_MS

/**
 * Outside every semester the week number and parity stay defined — the calendar must show something
 * during the winter break — by extending the last semester that has already started (or the first one,
 * for dates before the academic year begins). Mirrors `anchorOf` in backend/src/schedule.ts.
 */
export function semesterAnchorOf(isoDate: string, list: Semester[] = semesters): Semester {
  const started = list.filter((semester) => semester.start <= isoDate)
  return started.length ? started[started.length - 1] : list[0]
}

/** Week 1 is the semester's first week; weeks before its start are 0, -1, … (backend `universityWeekNumber`). */
export function universityWeekNumber(isoDate: string, list: Semester[] = semesters): number {
  return Math.round((mondayTime(isoDate) - mondayTime(semesterAnchorOf(isoDate, list).start)) / (7 * DAY_MS)) + 1
}

/** Week parity for a `YYYY-MM-DD` date (weeks start on Monday). Mirrors `universityWeekKind` in the backend. */
export function weekTypeFor(isoDate: string, list: Semester[] = semesters): WeekType {
  const anchor = semesterAnchorOf(isoDate, list)
  // Odd week numbers (1, 3, …) share the parity of the semester's first week.
  return Math.abs(universityWeekNumber(isoDate, list)) % 2 === 1 ? anchor.kind : otherWeekType(anchor.kind)
}

/** False during the summer holiday and between semesters: no lesson is held, so no reminder is due. */
export function isStudyDay(isoDate: string, list: Semester[] = semesters): boolean {
  return list.some((semester) => isoDate >= semester.start && (semester.end === null || isoDate <= semester.end))
}

export function lessonMatchesWeek(lesson: Lesson, week: WeekType) {
  return lesson.weekType === 'both' || lesson.weekType === week
}


/** "9:30", "09:30" and "09:30:00" (some mobile WebViews) → "09:30"; anything else → "". */
export function normalizeTime(value: string | undefined | null) {
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?$/.exec((value ?? '').trim())
  if (!match || Number(match[1]) > 23) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export function timeToMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function minutesToTime(total: number) {
  const clamped = Math.max(0, Math.min(total, 23 * 60 + 59))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

export const byStartTime = (a: Lesson, b: Lesson) => a.startTime.localeCompare(b.startTime)

/** SQLite `CURRENT_TIMESTAMP` values are UTC without a zone marker ("YYYY-MM-DD HH:MM:SS"). */
export function parseServerDate(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatServerDate(value: string) {
  const date = parseServerDate(value)
  return date ? date.toLocaleString('ro-RO', { timeZone: UNIVERSITY_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }) : ''
}

export type LessonTimeState = 'past' | 'current' | 'upcoming'
export type LessonTiming = {
  state: LessonTimeState
  /** Current lesson: whole minutes until it ends (at least 1). */
  minutesLeft?: number
  /** Current lesson: elapsed share, 0–1. */
  progress?: number
  /** Upcoming lesson today: minutes until it starts. */
  startsIn?: number
}

/** Where a lesson held on `isoDate` stands relative to the university clock: earlier days are over, later days are ahead. */
export function lessonTiming(lesson: Pick<Lesson, 'startTime' | 'endTime'>, isoDate: string, clock: UniversityClock): LessonTiming {
  if (isoDate < clock.isoDate) return { state: 'past' }
  if (isoDate > clock.isoDate) return { state: 'upcoming' }
  const start = timeToMinutes(lesson.startTime)
  const end = timeToMinutes(lesson.endTime)
  if (end <= clock.minutes) return { state: 'past' }
  if (start <= clock.minutes) {
    const duration = Math.max(end - start, 1)
    return { state: 'current', minutesLeft: Math.max(end - clock.minutes, 1), progress: Math.min(Math.max((clock.minutes - start) / duration, 0), 1) }
  }
  return { state: 'upcoming', startsIn: start - clock.minutes }
}
