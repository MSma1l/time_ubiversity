export type Role = 'student' | 'teacher'
export type WeekType = 'odd' | 'even'

export type Lesson = {
  id: string
  role: Role
  title: string
  group: string
  teacher?: string
  room: string
  weekday: number
  startTime: string
  endTime: string
  weekType: WeekType | 'both'
  reminderMinutes: number
  /** False when reminders are off for this lesson (editor or bot /notificari off). */
  notificationsEnabled: boolean
}

export type AppNotification = {
  id: number
  kind: 'reminder' | 'system'
  title: string
  body: string
  readAt: string | null
  createdAt: string
}
