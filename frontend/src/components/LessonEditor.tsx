import { useState, type FormEvent } from 'react'
import { useDialog } from '../dialogs'
import { minutesLabel } from '../labels'
import { minutesToTime, TIME_PATTERN, timeToMinutes, weekdayNames } from '../schedule'
import type { Lesson, Role } from '../types'

/** Mirrors backend lessonSchema limits. */
const LESSON_LIMITS = { title: 120, group: 80, teacher: 100, room: 60 } as const
const DEFAULT_DURATION_MINUTES = 90
const DEFAULT_REMINDER_MINUTES = 15
const REMINDER_OPTIONS = [5, 10, 15, 30, 60]
const REMINDER_OFF = 'off'

type Props = {
  role: Role
  existing: Lesson | null
  slot: { day: number, time: string } | null
  onClose(): void
  /** Resolves to true when the lesson was saved (the parent closes the editor). */
  onSave(lesson: Lesson): Promise<boolean>
  onDelete?(): Promise<void>
}

const newLocalId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export function LessonEditor({ role, existing, slot, onClose, onSave, onDelete }: Props) {
  const dialogRef = useDialog<HTMLFormElement>(onClose)
  const lessonRole = existing?.role ?? role
  const initialStart = existing?.startTime ?? slot?.time ?? '08:00'
  const [title, setTitle] = useState(existing?.title ?? '')
  const [group, setGroup] = useState(existing?.group ?? '')
  const [teacher, setTeacher] = useState(existing?.teacher ?? '')
  const [room, setRoom] = useState(existing?.room === '—' ? '' : existing?.room ?? '')
  const [day, setDay] = useState(existing?.weekday ?? slot?.day ?? 0)
  const [week, setWeek] = useState<Lesson['weekType']>(existing?.weekType ?? 'both')
  const [startTime, setStartTime] = useState(initialStart)
  const [endTime, setEndTime] = useState(existing?.endTime ?? minutesToTime(timeToMinutes(initialStart) + DEFAULT_DURATION_MINUTES))
  const savedMinutes = existing?.reminderMinutes ?? DEFAULT_REMINDER_MINUTES
  const [reminder, setReminder] = useState(existing && !existing.notificationsEnabled ? REMINDER_OFF : String(savedMinutes))
  // Keep a custom value (e.g. set before this control existed) selectable.
  const reminderOptions = REMINDER_OPTIONS.includes(savedMinutes) ? REMINDER_OPTIONS : [...REMINDER_OPTIONS, savedMinutes].sort((a, b) => a - b)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changeStart = (value: string) => {
    // Keep the lesson duration when the start time moves.
    if (TIME_PATTERN.test(value) && TIME_PATTERN.test(startTime) && TIME_PATTERN.test(endTime)) {
      setEndTime(minutesToTime(timeToMinutes(value) + Math.max(timeToMinutes(endTime) - timeToMinutes(startTime), 5)))
    }
    setStartTime(value)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!title.trim()) return setError('Completează disciplina.')
    if (!group.trim()) return setError('Completează grupa.')
    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) return setError('Alege ora de început și de final.')
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) return setError('Ora de final trebuie să fie după ora de început.')
    setError('')
    setBusy(true)
    const saved = await onSave({
      id: existing?.id ?? newLocalId(), role: lessonRole, title: title.trim(), group: group.trim(), teacher: teacher.trim() || undefined,
      weekday: day, startTime, endTime, room: room.trim() || '—', weekType: week,
      reminderMinutes: reminder === REMINDER_OFF ? savedMinutes : Number(reminder), notificationsEnabled: reminder !== REMINDER_OFF,
    })
    if (!saved) setBusy(false)
  }

  const remove = async () => {
    if (!onDelete || busy) return
    setBusy(true)
    try { await onDelete() } finally { setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation">
    <form ref={dialogRef} className="editor" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="editor-title" tabIndex={-1} noValidate>
      <div className="modal-heading">
        <div><p>ORAR MANUAL</p><h2 id="editor-title">{existing ? 'Editează ora' : 'Adaugă o oră'}</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <label>Disciplina<input required maxLength={LESSON_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Algoritmi" /></label>
      <div className="form-row">
        <label>Grupa<input required maxLength={LESSON_LIMITS.group} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="ex. FAF-241" /></label>
        <label>Sala<input maxLength={LESSON_LIMITS.room} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="ex. 213/4" /></label>
      </div>
      {lessonRole === 'student' && <label>Profesor<input maxLength={LESSON_LIMITS.teacher} value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="ex. D. Rusu (opțional)" /></label>}
      <div className="form-row">
        <label>Ziua<select value={day} onChange={(e) => setDay(Number(e.target.value))}>{weekdayNames.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></label>
        <label>Săptămână<select value={week} onChange={(e) => setWeek(e.target.value as Lesson['weekType'])}><option value="both">În fiecare săptămână</option><option value="even">Pară</option><option value="odd">Impară</option></select></label>
      </div>
      <div className="form-row">
        <label>Începe la<input type="time" required value={startTime} onChange={(e) => changeStart(e.target.value)} /></label>
        <label>Se termină la<input type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label>
      </div>
      <label>Memento<select value={reminder} onChange={(e) => setReminder(e.target.value)}>
        <option value={REMINDER_OFF}>Fără memento</option>
        {reminderOptions.map((minutes) => <option key={minutes} value={String(minutes)}>{minutes === 0 ? 'La începutul orei' : `Cu ${minutesLabel(minutes)} înainte`}</option>)}
      </select></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="editor-actions">
        {onDelete && <button className="delete-button" type="button" onClick={remove} disabled={busy}>Șterge</button>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Se salvează…' : existing ? 'Salvează modificările' : 'Salvează ora'}</button>
      </div>
    </form>
  </div>
}
