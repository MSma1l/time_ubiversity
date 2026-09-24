import { isValidIsoDate, normalizeTime, universityClock } from './schedule'
import type { Semester } from './schedule'
import type { AppNotification, Lesson, Role, WeekType } from './types'

const apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const REQUEST_TIMEOUT_MS = 15_000
/** Dev-only auth bypass (backend must run with ALLOW_DEV_AUTH=true). Stripped from production builds. */
export const devTelegramId = import.meta.env.DEV ? (import.meta.env.VITE_DEV_TELEGRAM_ID ?? '') : ''

/** A field rejected by the backend validation, with a user-facing Romanian message. */
export type FieldError = { path: string, label: string, message: string }

export class ApiError extends Error {
  readonly status: number
  readonly fields: FieldError[]
  constructor(message: string, status: number, fields: FieldError[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fields = fields
  }
}

type ErrorBody = { error?: unknown, fields?: Array<{ path?: unknown, message?: unknown }> }

const fieldLabels: Record<string, string> = {
  title: 'disciplina', groupName: 'grupa', teacherName: 'profesorul', room: 'sala', weekday: 'ziua', startTime: 'ora de început',
  endTime: 'ora de final', weekKind: 'săptămâna', reminderMinutes: 'memento', notificationsEnabled: 'memento', role: 'rolul', name: 'numele grupei', subject: 'disciplina',
  firstName: 'prenumele', lastName: 'numele', grade: 'nota', laboratory: 'laboratorul', date: 'data', entries: 'prezența',
}

/** zod's English default messages (schemas without custom Romanian text) are replaced by a generic hint. */
const isEnglishDefault = (message: string) => /^(invalid|too (big|small)|expected|unrecognized)/i.test(message)

function fieldErrors(body: ErrorBody | null): FieldError[] {
  return (body?.fields ?? []).map((field) => {
    const path = typeof field.path === 'string' ? field.path.split('.')[0] : ''
    const message = typeof field.message === 'string' && field.message && !isEnglishDefault(field.message) ? field.message : 'Valoare invalidă'
    return { path, label: fieldLabels[path] ?? '', message }
  })
}

function messageForStatus(status: number, body: ErrorBody | null, fields: FieldError[]) {
  const serverMessage = typeof body?.error === 'string' ? body.error : ''
  if (status === 401 || status === 403) return 'Sesiunea Telegram a expirat. Închide și redeschide Mini App-ul din bot.'
  if (status === 400) {
    const describe = ({ label, message }: FieldError) => !label || message.toLowerCase().startsWith(label) ? message : `${label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`
    const details = [...new Set(fields.map(describe))]
    return details.length ? `Date invalide — ${details.join('; ')}.` : 'Datele introduse nu sunt valide.'
  }
  if (status === 413) return 'Datele trimise sunt prea mari.'
  if (status === 429) return 'Prea multe cereri. Așteaptă puțin și încearcă din nou.'
  if (status >= 500 && status !== 503) return 'A apărut o eroare pe server. Încearcă din nou în câteva momente.'
  // 404 / 409 / 503 messages from the backend are already user-facing Romanian text.
  return serverMessage || 'Cererea nu a reușit. Încearcă din nou.'
}

/** The request was cut short by the timeout (fetch and the body read both reject with AbortError). */
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  const initData = window.Telegram?.WebApp?.initData ?? ''
  if (initData) headers.set('X-Telegram-Init-Data', initData)
  else if (devTelegramId) headers.set('X-Dev-Telegram-Id', devTelegramId)

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  // The timeout covers the body too: a connection that stalls after the headers must not hang the caller forever.
  try {
    let response: Response
    try {
      response = await fetch(`${apiBase}${path}`, { ...options, headers, signal: controller.signal })
    } catch (error) {
      throw new ApiError(aborted(error) ? 'Serverul nu răspunde. Încearcă din nou.' : 'Nu există conexiune cu serverul. Verifică internetul și încearcă din nou.', 0)
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null) as ErrorBody | null
      const fields = response.status === 400 ? fieldErrors(body) : []
      throw new ApiError(messageForStatus(response.status, body, fields), response.status, fields)
    }
    if (response.status === 204) return undefined as T
    try {
      return await response.json() as T
    } catch (error) {
      if (aborted(error)) throw new ApiError('Serverul nu răspunde. Încearcă din nou.', 0)
      throw new ApiError('Serverul a trimis un răspuns neașteptat.', response.status)
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/** User-facing Romanian message for any error thrown by the API layer. */
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback
}

/** 401/403 from any request: the Telegram `initData` is no longer valid and nothing can be saved until the app is reopened. */
export const isSessionExpired = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403)

type ApiLesson = { id: number, role: Role, title: string, groupName: string | null, teacherName: string | null, room: string | null, weekday: number, startTime: string, endTime: string, weekKind: 'odd' | 'even' | 'every', reminderMinutes: number, notificationsEnabled?: boolean | number }

/** Lessons from older app versions may carry unexpected values; normalising keeps them visible in the right schedule. */
const fromApi = (item: ApiLesson): Lesson => ({
  id: String(item.id), role: item.role === 'teacher' ? 'teacher' : 'student', title: item.title, group: item.groupName ?? '', teacher: item.teacherName ?? undefined, room: item.room ?? '—',
  weekday: Math.min(Math.max(Number(item.weekday) - 1, 0), 6), startTime: normalizeTime(item.startTime) || item.startTime, endTime: normalizeTime(item.endTime) || item.endTime,
  weekType: item.weekKind === 'odd' || item.weekKind === 'even' ? item.weekKind : 'both', reminderMinutes: Number.isInteger(item.reminderMinutes) ? item.reminderMinutes : 15,
  notificationsEnabled: item.notificationsEnabled === undefined ? true : Boolean(item.notificationsEnabled),
})

/** Pasted text may contain tabs or line breaks, which the backend rejects. */
const cleanText = (value: string | undefined) => (value ?? '').replace(/\p{Cc}+/gu, ' ').trim()

const toApi = (lesson: Lesson) => JSON.stringify({
  role: lesson.role, title: cleanText(lesson.title), groupName: cleanText(lesson.group) || null, teacherName: cleanText(lesson.teacher) || null,
  room: lesson.room === '—' ? null : cleanText(lesson.room) || null, weekday: lesson.weekday + 1, startTime: normalizeTime(lesson.startTime) || lesson.startTime, endTime: normalizeTime(lesson.endTime) || lesson.endTime,
  weekKind: lesson.weekType === 'both' ? 'every' : lesson.weekType, reminderMinutes: lesson.reminderMinutes, notificationsEnabled: lesson.notificationsEnabled,
})

export type AccountProfile = { displayName: string, role: Role, studentEnabled: boolean, teacherEnabled: boolean }
// SQLite returns 0/1 integers for the *_enabled columns.
type ApiProfile = { displayName?: string | null, role?: Role, studentEnabled?: boolean | number, teacherEnabled?: boolean | number }
const normalizeProfile = (profile: ApiProfile): AccountProfile => ({
  displayName: profile.displayName ?? '', role: profile.role === 'teacher' ? 'teacher' : 'student',
  studentEnabled: profile.studentEnabled === undefined ? true : Boolean(profile.studentEnabled),
  teacherEnabled: profile.teacherEnabled === undefined ? true : Boolean(profile.teacherEnabled),
})

export async function loadAccount() {
  const [me, items, notifications] = await Promise.all([
    request<{ profile: ApiProfile }>('/api/me'), request<ApiLesson[]>('/api/lessons'), request<AppNotification[]>('/api/notifications'),
  ])
  return { profile: normalizeProfile(me.profile ?? {}), lessons: items.map(fromApi), notifications }
}

export type NonWorkingDay = { date: string, label: string }
/** What `GET /api/week` tells the app: the calendar it must compute parity with, plus the week's days off. */
export type WeekCalendar = { date: string, semesters: Semester[], nonWorkingDays: NonWorkingDay[] }

type ApiSemester = { start?: unknown, kind?: unknown, end?: unknown }
type ApiWeek = {
  date?: unknown, semesters?: unknown, nonWorkingDays?: unknown
  /** Older backends describe a single open-ended anchor instead of a semester list. */
  referenceMonday?: unknown, referenceKind?: unknown
}
const isWeekType = (value: unknown): value is WeekType => value === 'even' || value === 'odd'

/** Anything the server did not send (or sent malformed) is dropped; the caller then keeps the built-in default. */
function normalizeWeek(body: ApiWeek): WeekCalendar {
  const list = (Array.isArray(body.semesters) ? body.semesters : []) as ApiSemester[]
  const semesters: Semester[] = list
    .filter((item) => Boolean(item) && isValidIsoDate(item.start) && isWeekType(item.kind))
    .map((item) => ({ start: item.start as string, kind: item.kind as WeekType, end: isValidIsoDate(item.end) ? item.end : null }))
  if (!semesters.length && isValidIsoDate(body.referenceMonday) && isWeekType(body.referenceKind)) semesters.push({ start: body.referenceMonday, kind: body.referenceKind, end: null })
  const days = (Array.isArray(body.nonWorkingDays) ? body.nonWorkingDays : []) as Array<{ date?: unknown, label?: unknown }>
  const nonWorkingDays = days
    .filter((item) => Boolean(item) && isValidIsoDate(item.date))
    .map((item) => ({ date: item.date as string, label: (typeof item.label === 'string' && item.label.trim()) || 'Zi nelucrătoare' }))
  return { date: isValidIsoDate(body.date) ? body.date : universityClock().isoDate, semesters, nonWorkingDays }
}

/** Academic calendar around `date` (default: today): the configured semesters and the non-working days of that week. */
export const loadWeekCalendar = async (date?: string) =>
  normalizeWeek(await request<ApiWeek>(`/api/week${date ? `?date=${encodeURIComponent(date)}` : ''}`))

export async function saveLessonRemote(lesson: Lesson) {
  return fromApi(await request<ApiLesson>('/api/lessons', { method: 'POST', body: toApi(lesson) }))
}
/** Only ids issued by the server can be updated or deleted; local ids never reach the API. */
const serverId = (id: string) => {
  if (!/^\d+$/.test(id)) throw new ApiError('Ora nu a fost încă salvată pe server. Închide editorul și adaug-o din nou.', 0)
  return id
}
export async function updateLessonRemote(lesson: Lesson) {
  return fromApi(await request<ApiLesson>(`/api/lessons/${serverId(lesson.id)}`, { method: 'PUT', body: toApi(lesson) }))
}
export const deleteLessonRemote = async (id: string) => request<void>(`/api/lessons/${serverId(id)}`, { method: 'DELETE' })

/** PATCH /api/me answers with the updated profile (some backend versions wrap it in `{ profile }`). */
const patchProfile = async (change: Partial<Pick<AccountProfile, 'role' | 'studentEnabled' | 'teacherEnabled'>>) => {
  const body = await request<ApiProfile & { profile?: ApiProfile }>('/api/me', { method: 'PATCH', body: JSON.stringify(change) })
  const profile = body?.profile ?? body ?? {}
  // Only the fields the server actually returned; missing ones must not reset local state to defaults.
  const result: Partial<Pick<AccountProfile, 'role' | 'studentEnabled' | 'teacherEnabled'>> = {}
  if (profile.role === 'student' || profile.role === 'teacher') result.role = profile.role
  if (profile.studentEnabled !== undefined && profile.studentEnabled !== null) result.studentEnabled = Boolean(profile.studentEnabled)
  if (profile.teacherEnabled !== undefined && profile.teacherEnabled !== null) result.teacherEnabled = Boolean(profile.teacherEnabled)
  return result
}
export const updateRole = (role: Role) => patchProfile({ role })
export const updateProfileState = (change: Partial<Pick<AccountProfile, 'studentEnabled' | 'teacherEnabled'>>) => patchProfile(change)
/** All notifications of the account (both schedules); the UI filters them per role. */
export const loadNotifications = () => request<AppNotification[]>('/api/notifications')
/** Marks as read the notifications of one schedule plus the general ones. */
export const markNotificationsRead = (role: Role) => request<void>('/api/notifications/read', { method: 'PATCH', body: JSON.stringify({ role }) })

export type TeacherGroup = {
  id: string, name: string, subject?: string | null, student_count: number
  /** Teacher lessons with the same group name (case-insensitive); absent on backends without the schedule link. */
  linkedLessons?: number
  /** Distinct lesson titles of those lessons. */
  subjects?: string[]
}
type ApiTeacherGroup = Omit<TeacherGroup, 'linkedLessons' | 'subjects' | 'student_count'> & { student_count?: number | string, linkedLessons?: number | string, linked_lessons?: number | string, subjects?: unknown }
/** PostgreSQL counts may arrive as strings; the schedule-link fields are optional. */
const fromApiGroup = ({ linked_lessons: linkedSnake, linkedLessons: linkedCamel, subjects, student_count: studentCount, ...group }: ApiTeacherGroup): TeacherGroup => {
  const result: TeacherGroup = { ...group, student_count: Number(studentCount) || 0 }
  const linked = Number(linkedCamel ?? linkedSnake)
  if ((linkedCamel ?? linkedSnake) !== undefined && Number.isFinite(linked)) result.linkedLessons = linked
  if (Array.isArray(subjects)) result.subjects = subjects.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return result
}
export type TeacherStudent = { id: string, first_name: string, last_name: string }
export type AttendanceStatus = 'present' | 'absent' | 'late'

export const loadTeacherGroups = async () => (await request<ApiTeacherGroup[]>('/api/teacher/groups')).map(fromApiGroup)
export const createTeacherGroup = async (name: string, subject: string) =>
  fromApiGroup(await request<ApiTeacherGroup>('/api/teacher/groups', { method: 'POST', body: JSON.stringify({ name: name.trim(), subject: subject.trim() || undefined }) }))
export const loadTeacherStudents = (groupId: string) => request<TeacherStudent[]>(`/api/teacher/groups/${encodeURIComponent(groupId)}/students`)
export const createTeacherStudent = (groupId: string, firstName: string, lastName: string) =>
  request<TeacherStudent>(`/api/teacher/groups/${encodeURIComponent(groupId)}/students`, { method: 'POST', body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }) })
/** Upserts only the given entries for the day's session (default: today in the university time zone). */
export const saveAttendance = (groupId: string, entries: Array<{ studentId: string, status: AttendanceStatus }>, date = universityClock().isoDate) =>
  request<void>(`/api/teacher/groups/${encodeURIComponent(groupId)}/attendance`, { method: 'POST', body: JSON.stringify({ date, entries }) })
/** Saving the same laboratory again replaces the previous grade. */
export const saveLabGrade = (studentId: string, laboratory: string, grade: number) =>
  request<LabGrade>(`/api/teacher/students/${encodeURIComponent(studentId)}/grades`, { method: 'POST', body: JSON.stringify({ laboratory: laboratory.trim(), grade, presentedOn: universityClock().isoDate }) })

export type LabGrade = { id: string, student_id: string, laboratory: string, presented_on: string | null, grade: number, feedback: string | null, created_at: string }
export type SavedAttendance = { date: string, sessionId: string | null, topic: string | null, entries: Array<{ studentId: string, status: AttendanceStatus }> }
export type Laboratory = { id: string, groupId: string, number: number, label: string, createdAt: string }
export type GroupStatistics = {
  group: { id: string, name: string }, studentCount: number
  attendance: { sessionCount: number, recordedCount: number, presentCount: number, absentCount: number, lateCount: number, unmarkedCount: number, sessions: Array<{ date: string, topic: string | null, recorded: number, present: number, absent: number, late: number, unmarked: number }> }
  grades: { gradedCount: number, average: number | null, laboratories: Array<{ id: string, number: number, label: string, gradedCount: number, missingCount: number, average: number | null, min: number | null, max: number | null }> }
  students: Array<{ id: string, firstName: string, lastName: string, present: number, absent: number, late: number, attendanceEvents: Array<{ date: string, status: 'absent' | 'late', topic: string | null }>, gradedCount: number, average: number | null, grades: Array<{ id: string, laboratory: string, grade: number, presentedOn: string | null }> }>
}

/** Saved attendance of one day (default: today in the university time zone). */
export const loadAttendance = (groupId: string, date = universityClock().isoDate) =>
  request<SavedAttendance>(`/api/teacher/groups/${encodeURIComponent(groupId)}/attendance?date=${encodeURIComponent(date)}`)
export const loadLabGrades = (studentId: string) => request<LabGrade[]>(`/api/teacher/students/${encodeURIComponent(studentId)}/grades`)
export const loadLaboratories = (groupId: string) => request<Laboratory[]>(`/api/teacher/groups/${encodeURIComponent(groupId)}/laboratories`)
export const createLaboratory = (groupId: string) => request<Laboratory>(`/api/teacher/groups/${encodeURIComponent(groupId)}/laboratories`, { method: 'POST', body: JSON.stringify({}) })
export const loadGroupStatistics = (groupId: string) => request<GroupStatistics>(`/api/teacher/groups/${encodeURIComponent(groupId)}/statistics`)
export const renameTeacherGroup = async (groupId: string, name: string) =>
  fromApiGroup(await request<ApiTeacherGroup>(`/api/teacher/groups/${encodeURIComponent(groupId)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }))
export const deleteTeacherGroup = (groupId: string) => request<void>(`/api/teacher/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' })
export const renameTeacherStudent = (studentId: string, firstName: string, lastName: string) =>
  request<TeacherStudent>(`/api/teacher/students/${encodeURIComponent(studentId)}`, { method: 'PATCH', body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }) })
export const deleteTeacherStudent = (studentId: string) => request<void>(`/api/teacher/students/${encodeURIComponent(studentId)}`, { method: 'DELETE' })
