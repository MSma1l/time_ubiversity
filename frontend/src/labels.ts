import type { LessonTiming } from './schedule'
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

/** Romanian count phrase for lessons: "1 oră", "2 ore", "20 de ore". */
export function lessonsLabel(count: number) {
  if (count === 1) return '1 oră'
  const rest = count % 100
  return rest >= 20 || (count >= 100 && rest === 0) ? `${count} de ore` : `${count} ore`
}

/** "Începe în N min" is shown only this close to the start. */
const STARTS_SOON_MINUTES = 60

/** Short visible badge and the matching screen-reader phrase for a lesson's time state. */
export function timingText(timing: LessonTiming | undefined) {
  if (!timing) return null
  if (timing.state === 'past') return { badge: 'Încheiată', spoken: 'încheiată' }
  if (timing.state === 'current') return { badge: `Acum · mai sunt ${timing.minutesLeft} min`, spoken: `în desfășurare, mai sunt ${timing.minutesLeft} minute` }
  if (timing.startsIn !== undefined && timing.startsIn < STARTS_SOON_MINUTES) return { badge: `Începe în ${timing.startsIn} min`, spoken: `începe în ${timing.startsIn} minute` }
  return null
}
