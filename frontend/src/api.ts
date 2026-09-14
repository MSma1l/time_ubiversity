import { universityClock } from './schedule'
import type { AppNotification, Lesson, Role } from './types'

const apiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const REQUEST_TIMEOUT_MS = 15_000
/** Dev-only auth bypass (backend must run with ALLOW_DEV_AUTH=true). Stripped from production builds. */
export const devTelegramId = import.meta.env.DEV ? (import.meta.env.VITE_DEV_TELEGRAM_ID ?? '') : ''

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type ErrorBody = { error?: unknown, fields?: Array<{ path?: string }> }

const fieldLabels: Record<string, string> = {
  title: 'disciplina', groupName: 'grupa', teacherName: 'profesorul', room: 'sala', weekday: 'ziua', startTime: 'ora de început',
  endTime: 'ora de final', weekKind: 'săptămâna', reminderMinutes: 'memento', name: 'numele grupei', subject: 'disciplina',
  firstName: 'prenumele', lastName: 'numele', grade: 'nota', laboratory: 'laboratorul', date: 'data', entries: 'prezența',
}

function messageForStatus(status: number, body: ErrorBody | null) {
  const serverMessage = typeof body?.error === 'string' ? body.error : ''
  if (status === 401 || status === 403) return 'Sesiunea Telegram a expirat. Închide și redeschide Mini App-ul din bot.'
  if (status === 400) {
    const labels = [...new Set((body?.fields ?? []).map((field) => fieldLabels[field.path?.split('.')[0] ?? '']).filter(Boolean))]
    return labels.length ? `Date invalide: verifică ${labels.join(', ')}.` : 'Datele introduse nu sunt valide.'
  }
  if (status === 413) return 'Datele trimise sunt prea mari.'
  if (status === 429) return 'Prea multe cereri. Așteaptă puțin și încearcă din nou.'
  if (status >= 500 && status !== 503) return 'A apărut o eroare pe server. Încearcă din nou în câteva momente.'
  // 404 / 409 / 503 messages from the backend are already user-facing Romanian text.
  return serverMessage || 'Cererea nu a reușit. Încearcă din nou.'
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  const initData = window.Telegram?.WebApp?.initData ?? ''
  if (initData) headers.set('X-Telegram-Init-Data', initData)
  else if (devTelegramId) headers.set('X-Dev-Telegram-Id', devTelegramId)

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, { ...options, headers, signal: controller.signal })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'AbortError'
    throw new ApiError(timedOut ? 'Serverul nu răspunde. Încearcă din nou.' : 'Nu există conexiune cu serverul. Verifică internetul și încearcă din nou.', 0)
  } finally {
    window.clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as ErrorBody | null
    throw new ApiError(messageForStatus(response.status, body), response.status)
  }
  if (response.status === 204) return undefined as T
  try {
    return await response.json() as T
  } catch {
    throw new ApiError('Serverul a trimis un răspuns neașteptat.', response.status)
  }
}

/** User-facing Romanian message for any error thrown by the API layer. */
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback
}

type ApiLesson = { id: number, role: Role, title: string, groupName: string | null, teacherName: string | null, room: string | null, weekday: number, startTime: string, endTime: string, weekKind: 'odd' | 'even' | 'every', reminderMinutes: number, notificationsEnabled?: boolean | number }

const fromApi = (item: ApiLesson): Lesson => ({
  id: String(item.id), role: item.role, title: item.title, group: item.groupName ?? '', teacher: item.teacherName ?? undefined, room: item.room ?? '—',
  weekday: item.weekday - 1, startTime: item.startTime, endTime: item.endTime, weekType: item.weekKind === 'every' ? 'both' : item.weekKind, reminderMinutes: item.reminderMinutes,
  notificationsEnabled: item.notificationsEnabled === undefined ? true : Boolean(item.notificationsEnabled),
})

const toApi = (lesson: Lesson) => JSON.stringify({
  role: lesson.role, title: lesson.title.trim(), groupName: lesson.group.trim() || null, teacherName: lesson.teacher?.trim() || null,
  room: lesson.room === '—' ? null : lesson.room.trim() || null, weekday: lesson.weekday + 1, startTime: lesson.startTime, endTime: lesson.endTime,
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

export async function saveLessonRemote(lesson: Lesson) {
  return fromApi(await request<ApiLesson>('/api/lessons', { method: 'POST', body: toApi(lesson) }))
}
export async function updateLessonRemote(lesson: Lesson) {
  return fromApi(await request<ApiLesson>(`/api/lessons/${encodeURIComponent(lesson.id)}`, { method: 'PUT', body: toApi(lesson) }))
}
export const deleteLessonRemote = (id: string) => request<void>(`/api/lessons/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const updateRole = (role: Role) => request<ApiProfile>('/api/me', { method: 'PATCH', body: JSON.stringify({ role }) })
export const updateProfileState = (change: Partial<Pick<AccountProfile, 'studentEnabled' | 'teacherEnabled'>>) =>
  request<ApiProfile>('/api/me', { method: 'PATCH', body: JSON.stringify(change) })
export const markNotificationsRead = () => request<void>('/api/notifications/read', { method: 'PATCH' })

export type TeacherGroup = { id: string, name: string, subject?: string | null, student_count: number }
export type TeacherStudent = { id: string, first_name: string, last_name: string }
export type AttendanceStatus = 'present' | 'absent' | 'late'

export const loadTeacherGroups = () => request<TeacherGroup[]>('/api/teacher/groups')
export const createTeacherGroup = (name: string, subject: string) =>
  request<TeacherGroup>('/api/teacher/groups', { method: 'POST', body: JSON.stringify({ name: name.trim(), subject: subject.trim() || undefined }) })
export const loadTeacherStudents = (groupId: string) => request<TeacherStudent[]>(`/api/teacher/groups/${encodeURIComponent(groupId)}/students`)
export const createTeacherStudent = (groupId: string, firstName: string, lastName: string) =>
  request<TeacherStudent>(`/api/teacher/groups/${encodeURIComponent(groupId)}/students`, { method: 'POST', body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }) })
/** Upserts only the given entries for today's session (university time zone). */
export const saveAttendance = (groupId: string, entries: Array<{ studentId: string, status: AttendanceStatus }>) =>
  request<void>(`/api/teacher/groups/${encodeURIComponent(groupId)}/attendance`, { method: 'POST', body: JSON.stringify({ date: universityClock().isoDate, entries }) })
export const saveLabGrade = (studentId: string, laboratory: string, grade: number) =>
  request<unknown>(`/api/teacher/students/${encodeURIComponent(studentId)}/grades`, { method: 'POST', body: JSON.stringify({ laboratory: laboratory.trim(), grade, presentedOn: universityClock().isoDate }) })
