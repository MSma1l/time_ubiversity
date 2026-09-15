import type { Lesson, WeekType } from './types'

/** All schedule logic follows the university's local time, independent of the device time zone. */
export const UNIVERSITY_TIME_ZONE = 'Europe/Chisinau'
/** Academic calendar baseline: the week of 7–13 September 2026 is an even week. */
const REFERENCE_MONDAY = '2026-09-07'
const DAY_MS = 86_400_000

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

/** Week parity for a `YYYY-MM-DD` date (weeks start on Monday). Mirrors backend/src/schedule.ts. */
export function weekTypeFor(isoDate: string): WeekType {
  const mondayOf = (value: string) => noonUtc(value).getTime() - weekdayIndexOf(value) * DAY_MS
  const weeks = Math.round((mondayOf(isoDate) - mondayOf(REFERENCE_MONDAY)) / (7 * DAY_MS))
  return Math.abs(weeks) % 2 === 0 ? 'even' : 'odd'
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
