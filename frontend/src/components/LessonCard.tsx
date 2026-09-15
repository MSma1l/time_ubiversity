import { timingText } from '../labels'
import type { LessonTiming } from '../schedule'
import type { Lesson, Role } from '../types'

const weekLabels: Record<Lesson['weekType'], string> = { both: 'În fiecare săptămână', even: 'Doar săptămână pară', odd: 'Doar săptămână impară' }
const tones: Record<Lesson['weekType'], string> = { both: 'teal', even: 'blue', odd: 'violet' }

type Props = {
  lesson: Lesson
  role: Role
  timing?: LessonTiming
  onEdit(): void
  /** Teacher schedule: opens the catalog on the lesson's group. */
  onOpenGroup?(group: string): void
}

export function LessonCard({ lesson, role, timing, onEdit, onOpenGroup }: Props) {
  const groupAction = role === 'teacher' && lesson.group && onOpenGroup
  const who = role === 'teacher' ? (groupAction ? '' : lesson.group) : lesson.teacher || lesson.group
  const state = timing?.state ?? 'upcoming'
  const text = timingText(timing)
  const summary = `${lesson.title}, ${lesson.startTime}–${lesson.endTime}${text ? `, ${text.spoken}` : ''}`
  return <article className={`lesson ${tones[lesson.weekType]} ${state}`} aria-label={summary}>
    <time>{lesson.startTime}<small>{lesson.endTime}</small></time>
    <div className="lesson-info">
      <div className="lesson-meta">
        <span>{weekLabels[lesson.weekType]}</span>
        {text && <b className={`lesson-state ${state}`} aria-hidden="true">{state === 'past' && <CheckIcon />}{state === 'current' && <i className="live-dot" />}{text.badge}</b>}
      </div>
      <h3>{lesson.title}</h3>
      <p>{who ? `${who} · ` : ''}Sala {lesson.room}</p>
      {groupAction && <button type="button" className="group-link" onClick={() => onOpenGroup(lesson.group)} aria-label={`Studenții grupei ${lesson.group}`}>
        <span aria-hidden="true">👥</span><b>{lesson.group}</b><small>· Studenți ›</small>
      </button>}
    </div>
    <button type="button" className="lesson-menu" onClick={onEdit} aria-label={`Editează ${lesson.title}`}>•••</button>
    {state === 'current' && timing?.progress !== undefined && <div className="lesson-progress" aria-hidden="true"><i style={{ width: `${Math.round(timing.progress * 100)}%` }} /></div>}
  </article>
}

export function CheckIcon() {
  return <svg className="check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
}

export function BellIcon() {
  return <svg className="bell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
}
