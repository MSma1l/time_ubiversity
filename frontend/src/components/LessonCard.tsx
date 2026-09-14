import type { Lesson, Role } from '../types'

const weekLabels: Record<Lesson['weekType'], string> = { both: 'În fiecare săptămână', even: 'Doar săptămână pară', odd: 'Doar săptămână impară' }
const tones: Record<Lesson['weekType'], string> = { both: 'teal', even: 'blue', odd: 'violet' }

export function LessonCard({ lesson, role, onEdit }: { lesson: Lesson, role: Role, onEdit(): void }) {
  const who = role === 'teacher' ? lesson.group : lesson.teacher || lesson.group
  return <article className={`lesson ${tones[lesson.weekType]}`}>
    <time>{lesson.startTime}<small>{lesson.endTime}</small></time>
    <div className="lesson-info">
      <span>{weekLabels[lesson.weekType]}</span>
      <h3>{lesson.title}</h3>
      <p>{who ? `${who} · ` : ''}Sala {lesson.room}</p>
    </div>
    <button type="button" onClick={onEdit} aria-label={`Editează ${lesson.title}`}>•••</button>
  </article>
}

export function BellIcon() {
  return <svg className="bell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
}
