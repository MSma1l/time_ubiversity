import { useState, type FormEvent } from 'react'
import { useDialog } from '../dialogs'
import { minutesLabel, roleLabels } from '../labels'
import { minutesToTime, normalizeTime, timeToMinutes, weekdayNames } from '../schedule'
import type { Lesson, Role } from '../types'

/** Mirrors backend lessonSchema limits. */
const LESSON_LIMITS = { title: 120, group: 80, teacher: 100, room: 60 } as const
const DEFAULT_DURATION_MINUTES = 90
const DEFAULT_REMINDER_MINUTES = 15
const REMINDER_OPTIONS = [5, 10, 15, 30, 60]
const REMINDER_OFF = 'off'

/** Why a save/delete failed: a Romanian message and the backend fields it concerns. */
export type EditorFailure = { message: string, fields: Array<{ path: string, message: string }> }

type Props = {
  /** Schedule of a new lesson, fixed when the editor opens; an existing lesson always keeps its own role. */
  role: Role
  existing: Lesson | null
  slot: { day: number, time: string } | null
  onClose(): void
  /** Resolves to null when the lesson was saved (the parent closes the editor), otherwise to the reason. */
  onSave(lesson: Lesson): Promise<EditorFailure | null>
  onDelete?(): Promise<EditorFailure | null>
  /** Teacher schedule: group names from the catalog, offered while typing (the group stays optional). */
  groupSuggestions?: string[]
}

/** Backend field names (lessonSchema) that have a control in this form. */
type FieldName = 'title' | 'groupName' | 'teacherName' | 'room' | 'weekday' | 'weekKind' | 'startTime' | 'endTime' | 'reminderMinutes'
type FieldErrors = Partial<Record<FieldName, string>>
const FIELD_ALIASES: Record<string, FieldName> = { notificationsEnabled: 'reminderMinutes' }

const MAX_GROUP_CHIPS = 6

const newLocalId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export function LessonEditor({ role, existing, slot, onClose, onSave, onDelete, groupSuggestions = [] }: Props) {
  const dialogRef = useDialog<HTMLFormElement>(onClose)
  // Captured once: a profile/role change while the editor is open must not move the lesson to the other schedule.
  const [lessonRole] = useState<Role>(existing?.role ?? role)
  const initialStart = normalizeTime(existing?.startTime ?? slot?.time) || '08:00'
  const [title, setTitle] = useState(existing?.title ?? '')
  const [group, setGroup] = useState(existing?.group ?? '')
  const [teacher, setTeacher] = useState(existing?.teacher ?? '')
  const [room, setRoom] = useState(existing?.room === '—' ? '' : existing?.room ?? '')
  const [day, setDay] = useState(existing?.weekday ?? slot?.day ?? 0)
  const [week, setWeek] = useState<Lesson['weekType']>(existing?.weekType ?? 'both')
  const [startTime, setStartTime] = useState(initialStart)
  const [endTime, setEndTime] = useState(normalizeTime(existing?.endTime) || minutesToTime(timeToMinutes(initialStart) + DEFAULT_DURATION_MINUTES))
  const savedMinutes = existing?.reminderMinutes ?? DEFAULT_REMINDER_MINUTES
  const [reminder, setReminder] = useState(existing && !existing.notificationsEnabled ? REMINDER_OFF : String(savedMinutes))
  // Keep a custom value (e.g. set before this control existed) selectable.
  const reminderOptions = REMINDER_OPTIONS.includes(savedMinutes) ? REMINDER_OPTIONS : [...REMINDER_OPTIONS, savedMinutes].sort((a, b) => a - b)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)
  const suggestGroups = lessonRole === 'teacher' && groupSuggestions.length > 0
  const typedGroup = group.trim().toLocaleLowerCase('ro')
  const groupChips = suggestGroups && !groupSuggestions.some((name) => name.toLocaleLowerCase('ro') === typedGroup)
    ? groupSuggestions.filter((name) => name.toLocaleLowerCase('ro').includes(typedGroup)).slice(0, MAX_GROUP_CHIPS) : []

  const fail = (message: string, fields: FieldErrors = {}) => { setError(message); setFieldErrors(fields) }
  const showFailure = (failure: EditorFailure) => {
    const fields: FieldErrors = {}
    for (const field of failure.fields) {
      const name = (FIELD_ALIASES[field.path] ?? field.path) as FieldName
      fields[name] ??= field.message
    }
    fail(failure.message, fields)
  }
  /** Marks a control invalid and links it to its message. */
  const invalid = (name: FieldName) => fieldErrors[name] ? { 'aria-invalid': true, 'aria-describedby': `lesson-${name}-error` } : {}
  const fieldMessage = (name: FieldName) => fieldErrors[name] ? <small className="field-error" id={`lesson-${name}-error`}>{fieldErrors[name]}</small> : null

  const changeStart = (value: string) => {
    // Keep the lesson duration when the start time moves.
    const [next, start, end] = [normalizeTime(value), normalizeTime(startTime), normalizeTime(endTime)]
    if (next && start && end) setEndTime(minutesToTime(timeToMinutes(next) + Math.max(timeToMinutes(end) - timeToMinutes(start), 5)))
    setStartTime(value)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const start = normalizeTime(startTime)
    const end = normalizeTime(endTime)
    if (!title.trim()) return fail('Completează disciplina.', { title: 'Câmpul este obligatoriu' })
    if (!start) return fail('Alege ora de început.', { startTime: 'Ora trebuie să fie în format HH:MM' })
    if (!end) return fail('Alege ora de final.', { endTime: 'Ora trebuie să fie în format HH:MM' })
    if (timeToMinutes(end) <= timeToMinutes(start)) return fail('Ora de final trebuie să fie după ora de început.', { endTime: 'Trebuie să fie după ora de început' })
    fail('')
    setBusy(true)
    const failure = await onSave({
      id: existing?.id ?? newLocalId(), role: lessonRole, title: title.trim(), group: group.trim(), teacher: teacher.trim() || undefined,
      weekday: day, startTime: start, endTime: end, room: room.trim() || '—', weekType: week,
      reminderMinutes: reminder === REMINDER_OFF ? savedMinutes : Number(reminder), notificationsEnabled: reminder !== REMINDER_OFF,
    })
    // On success the parent closes (unmounts) the editor; on failure the reason stays visible here.
    if (failure) { showFailure(failure); setBusy(false) }
  }

  const remove = async () => {
    if (!onDelete || busy) return
    fail('')
    setBusy(true)
    const failure = await onDelete()
    if (failure) showFailure(failure)
    setBusy(false)
  }

  return <div className="modal-backdrop" role="presentation">
    <form ref={dialogRef} className="editor" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="editor-title" tabIndex={-1} noValidate>
      <div className="modal-heading">
        <div><p>ORAR {roleLabels[lessonRole].toUpperCase()}</p><h2 id="editor-title">{existing ? 'Editează ora' : 'Adaugă o oră'}</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <label>Disciplina<input required maxLength={LESSON_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Algoritmi" {...invalid('title')} />{fieldMessage('title')}</label>
      <div className="form-row">
        <label>Grupa<input maxLength={LESSON_LIMITS.group} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="ex. FAF-241" list={suggestGroups ? 'lesson-group-suggestions' : undefined} autoComplete="off" {...invalid('groupName')} />{fieldMessage('groupName')}</label>
        <label>Sala<input maxLength={LESSON_LIMITS.room} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="ex. 213/4" {...invalid('room')} />{fieldMessage('room')}</label>
      </div>
      {suggestGroups && <datalist id="lesson-group-suggestions">{groupSuggestions.map((name) => <option key={name} value={name} />)}</datalist>}
      {groupChips.length > 0 && <div className="group-suggestions" role="group" aria-label="Grupele tale">
        <small>Grupele tale:</small>
        {groupChips.map((name) => <button type="button" key={name} onClick={() => setGroup(name)}><span aria-hidden="true">👥</span>{name}</button>)}
      </div>}
      {lessonRole === 'student' && <label>Profesor<input maxLength={LESSON_LIMITS.teacher} value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="ex. D. Rusu (opțional)" {...invalid('teacherName')} />{fieldMessage('teacherName')}</label>}
      <div className="form-row">
        <label>Ziua<select value={day} onChange={(e) => setDay(Number(e.target.value))} {...invalid('weekday')}>{weekdayNames.map((name, index) => <option key={name} value={index}>{name}</option>)}</select>{fieldMessage('weekday')}</label>
        <label>Săptămână<select value={week} onChange={(e) => setWeek(e.target.value as Lesson['weekType'])} {...invalid('weekKind')}><option value="both">În fiecare săptămână</option><option value="even">Pară</option><option value="odd">Impară</option></select>{fieldMessage('weekKind')}</label>
      </div>
      <div className="form-row">
        <label>Începe la<input type="time" required value={startTime} onChange={(e) => changeStart(e.target.value)} {...invalid('startTime')} />{fieldMessage('startTime')}</label>
        <label>Se termină la<input type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} {...invalid('endTime')} />{fieldMessage('endTime')}</label>
      </div>
      <label>Memento<select value={reminder} onChange={(e) => setReminder(e.target.value)} {...invalid('reminderMinutes')}>
        <option value={REMINDER_OFF}>Fără memento</option>
        {reminderOptions.map((minutes) => <option key={minutes} value={String(minutes)}>{minutes === 0 ? 'La începutul orei' : `Cu ${minutesLabel(minutes)} înainte`}</option>)}
      </select>{fieldMessage('reminderMinutes')}</label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="editor-actions">
        {onDelete && <button className="delete-button" type="button" onClick={remove} disabled={busy}>Șterge</button>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Se salvează…' : existing ? 'Salvează modificările' : 'Salvează ora'}</button>
      </div>
    </form>
  </div>
}
