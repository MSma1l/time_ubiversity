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

export function universityClock(date = new Date()): UniversityClock {
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

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

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
