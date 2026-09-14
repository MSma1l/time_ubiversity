import type { Role } from './types'

export const roleLabels: Record<Role, string> = { student: 'Student', teacher: 'Profesor' }

export function initialOf(name: string) {
  return (Array.from(name.trim())[0] ?? 'U').toUpperCase()
}

/** Romanian count phrase: "5 minute", "30 de minute". */
export function minutesLabel(count: number) {
  if (count === 1) return '1 minut'
  const rest = count % 100
  return rest >= 20 || (count >= 100 && rest === 0) ? `${count} de minute` : `${count} minute`
}
