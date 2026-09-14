import { useEffect, useState, type FormEvent } from 'react'
import { createTeacherGroup, createTeacherStudent, errorMessage, loadTeacherGroups, loadTeacherStudents, saveAttendance, saveLabGrade, type AttendanceStatus, type TeacherGroup, type TeacherStudent } from '../api'
import { useDialog } from '../dialogs'
import { formatDayMonth, universityClock } from '../schedule'

/** Mirrors backend groupSchema / studentSchema / grade limits. */
const LIMITS = { groupName: 80, subject: 120, personName: 80, laboratory: 120 } as const
const attendanceButtons: Array<{ status: AttendanceStatus, short: string, label: string }> = [
  { status: 'present', short: 'P', label: 'Prezent' }, { status: 'absent', short: 'A', label: 'Absent' }, { status: 'late', short: 'Î', label: 'Întârziat' },
]

type Props = { mode: 'settings' | 'records', available: boolean, onClose(): void }

export function TeacherCatalog({ mode, available, onClose }: Props) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  const isSettings = mode === 'settings'
  const [groups, setGroups] = useState<TeacherGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(available)
  const [groupsReload, setGroupsReload] = useState(0)
  const [selected, setSelected] = useState('')
  const [studentsState, setStudentsState] = useState<{ groupId: string, items: TeacherStudent[], failed: boolean }>({ groupId: '', items: [], failed: false })
  const [tab, setTab] = useState<'attendance' | 'grades'>('attendance')
  const [message, setMessage] = useState(available ? '' : 'Catalogul este disponibil doar când aplicația este deschisă din Telegram.')
  const [busy, setBusy] = useState(false)
  const [showStudentForm, setShowStudentForm] = useState(false)
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [groupName, setGroupName] = useState('')
  const [subject, setSubject] = useState('')
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({})
  const [laboratory, setLaboratory] = useState('Laborator')
  const [gradeFor, setGradeFor] = useState<string | null>(null)
  const [gradeValue, setGradeValue] = useState('')

  useEffect(() => {
    if (!available) return
    let active = true
    loadTeacherGroups()
      .then((items) => {
        if (!active) return
        setGroups(items)
        setSelected((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? '')
        setMessage('')
      })
      .catch((error) => { if (active) setMessage(errorMessage(error, 'Catalogul nu este disponibil momentan. Încearcă din nou în câteva momente.')) })
      .finally(() => { if (active) setGroupsLoading(false) })
    return () => { active = false }
  }, [available, groupsReload])

  useEffect(() => {
    if (!available || !selected) return
    let active = true
    loadTeacherStudents(selected)
      .then((items) => { if (active) setStudentsState({ groupId: selected, items, failed: false }) })
      .catch((error) => {
        if (!active) return
        setStudentsState({ groupId: selected, items: [], failed: true })
        setMessage(errorMessage(error, 'Nu s-au putut încărca studenții.'))
      })
    return () => { active = false }
  }, [available, selected])

  const studentsReady = Boolean(selected) && studentsState.groupId === selected
  const students = studentsReady ? studentsState.items : []

  const reloadGroups = () => { setGroupsLoading(true); setMessage(''); setGroupsReload((value) => value + 1) }

  const addGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (groupName.trim().length < 2) return setMessage('Numele grupei trebuie să aibă cel puțin 2 caractere.')
    setBusy(true)
    try {
      const group = await createTeacherGroup(groupName, subject)
      setGroups((items) => [...items, { ...group, student_count: group.student_count ?? 0 }].sort((a, b) => a.name.localeCompare(b.name, 'ro')))
      setSelected(group.id); setGroupName(''); setSubject(''); setShowGroupForm(false)
      setMessage(`Grupa ${group.name} a fost salvată.`)
    } catch (error) {
      setMessage(errorMessage(error, 'Grupa nu a fost salvată.'))
    } finally { setBusy(false) }
  }

  const addStudent = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !selected) return
    if (!firstName.trim() || !lastName.trim()) return setMessage('Completează numele și prenumele studentului.')
    const groupId = selected
    setBusy(true)
    try {
      const student = await createTeacherStudent(groupId, firstName, lastName)
      setStudentsState((state) => state.groupId === groupId ? { ...state, items: [...state.items, student] } : state)
      setGroups((items) => items.map((item) => item.id === groupId ? { ...item, student_count: item.student_count + 1 } : item))
      setFirstName(''); setLastName(''); setShowStudentForm(false)
      setMessage('Studentul a fost adăugat.')
    } catch (error) {
      setMessage(errorMessage(error, 'Studentul nu a fost salvat.'))
    } finally { setBusy(false) }
  }

  const markAttendance = async (student: TeacherStudent, status: AttendanceStatus) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      // Only this student's entry is sent, so earlier marks for other students are not overwritten.
      await saveAttendance(selected, [{ studentId: student.id, status }])
      setMarks((value) => ({ ...value, [student.id]: status }))
      setMessage(`Prezența pentru ${student.last_name} ${student.first_name} a fost salvată.`)
    } catch (error) {
      setMessage(errorMessage(error, 'Prezența nu a fost salvată.'))
    } finally { setBusy(false) }
  }

  const submitGrade = async (event: FormEvent, student: TeacherStudent) => {
    event.preventDefault()
    if (busy) return
    const score = Number(gradeValue.replace(',', '.'))
    if (gradeValue.trim() === '' || !Number.isFinite(score) || score < 0 || score > 10) return setMessage('Nota trebuie să fie un număr între 0 și 10.')
    if (!laboratory.trim()) return setMessage('Completează denumirea laboratorului.')
    setBusy(true)
    try {
      await saveLabGrade(student.id, laboratory, Math.round(score * 100) / 100)
      setGradeFor(null); setGradeValue('')
      setMessage(`Nota ${score} pentru ${student.last_name} ${student.first_name} a fost salvată.`)
    } catch (error) {
      setMessage(errorMessage(error, 'Nota nu a fost salvată.'))
    } finally { setBusy(false) }
  }

  const emptyTitle = groupsLoading ? 'Se încarcă grupele…' : !selected ? 'Alege o grupă' : !studentsReady ? 'Se încarcă studenții…' : 'Lista este goală'
  const emptyText = groupsLoading || (selected && !studentsReady) ? 'Un moment, te rog.'
    : !selected ? 'Creează sau selectează o grupă pentru a vedea catalogul.'
      : studentsState.failed ? 'Lista nu a putut fi încărcată.'
        : isSettings ? 'Adaugă primul student pentru a începe evidența.' : 'Adaugă studenți din Profil → Setări grupe.'

  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="catalog-panel" role="dialog" aria-modal="true" aria-labelledby="catalog-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>{isSettings ? 'PROFIL PROFESOR · SETĂRI' : 'CATALOG PROFESOR · EVIDENȚĂ'}</p><h2 id="catalog-title">{isSettings ? 'Setări grupe' : 'Prezență și note'}</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <p className="catalog-subtitle">{isSettings ? 'Creezi grupe și adaugi studenți în grupele existente.' : `Selectezi grupa și completezi prezența (pentru ${formatDayMonth(universityClock().isoDate)}) sau notele de laborator.`}</p>
      <div className="catalog-toolbar">
        <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!available || groupsLoading} aria-label="Grupa">
          <option value="">{groupsLoading ? 'Se încarcă…' : 'Alege grupa'}</option>
          {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {isSettings && available && <button type="button" onClick={() => setShowGroupForm(true)}>＋ Creează grupă</button>}
        {available && !groupsLoading && message && !groups.length && <button type="button" onClick={reloadGroups}>Reîncearcă</button>}
      </div>
      {isSettings && groups.length > 0 && <section className="existing-groups" aria-label="Grupe existente">
        <strong>Grupele mele</strong>
        <div>{groups.map((item) => <button type="button" className={item.id === selected ? 'selected' : ''} aria-pressed={item.id === selected} key={item.id} onClick={() => setSelected(item.id)}><span aria-hidden="true">👥</span>{item.name}<small>{item.student_count} stud.</small></button>)}</div>
      </section>}
      {isSettings && showGroupForm && <form className="catalog-form" onSubmit={addGroup}>
        <strong>Grupă nouă</strong>
        <input autoFocus required minLength={2} maxLength={LIMITS.groupName} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="ex. SI-265 PC" aria-label="Numele grupei" />
        <input maxLength={LIMITS.subject} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Disciplina (opțional)" aria-label="Disciplina" />
        <div><button type="button" onClick={() => setShowGroupForm(false)}>Anulează</button><button type="submit" disabled={busy}>Salvează grupa</button></div>
      </form>}
      {!isSettings && <nav className="catalog-tabs" aria-label="Tip evidență">
        <button type="button" className={tab === 'attendance' ? 'active' : ''} aria-pressed={tab === 'attendance'} onClick={() => setTab('attendance')}>Prezență</button>
        <button type="button" className={tab === 'grades' ? 'active' : ''} aria-pressed={tab === 'grades'} onClick={() => setTab('grades')}>Note</button>
      </nav>}
      {!isSettings && tab === 'grades' && studentsReady && students.length > 0 && <form className="catalog-form" onSubmit={(e) => e.preventDefault()}>
        <strong>Laborator</strong>
        <input maxLength={LIMITS.laboratory} value={laboratory} onChange={(e) => setLaboratory(e.target.value)} placeholder="ex. Laborator 1" aria-label="Denumirea laboratorului" />
      </form>}
      {message && <p className="catalog-message" role="status">{message}</p>}
      <div className="student-list">
        {isSettings && available && <>
          {!showStudentForm && <button type="button" className="add-student" disabled={!selected} onClick={() => setShowStudentForm(true)}>＋ Adaugă student</button>}
          {showStudentForm && <form className="catalog-form" onSubmit={addStudent}>
            <strong>Student nou</strong>
            <div className="form-row">
              <input autoFocus required maxLength={LIMITS.personName} value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Nume" aria-label="Nume" />
              <input required maxLength={LIMITS.personName} value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Prenume" aria-label="Prenume" />
            </div>
            <div><button type="button" onClick={() => setShowStudentForm(false)}>Anulează</button><button type="submit" disabled={busy}>Adaugă studentul</button></div>
          </form>}
        </>}
        {students.length ? students.map((student, index) => <article key={student.id}>
          <b>{index + 1}</b>
          <span>{student.last_name} {student.first_name}</span>
          {!isSettings && tab === 'attendance' && <div role="group" aria-label={`Prezența: ${student.last_name} ${student.first_name}`}>
            {attendanceButtons.map((item) => <button type="button" key={item.status} className={marks[student.id] === item.status ? 'selected' : ''} aria-pressed={marks[student.id] === item.status} title={item.label} aria-label={item.label} disabled={busy} onClick={() => markAttendance(student, item.status)}>{item.short}</button>)}
          </div>}
          {!isSettings && tab === 'grades' && (gradeFor === student.id
            ? <form className="grade-form" onSubmit={(e) => submitGrade(e, student)}>
              <input autoFocus inputMode="decimal" type="number" min={0} max={10} step={0.01} value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} aria-label={`Nota pentru ${student.last_name} ${student.first_name}`} placeholder="0–10" />
              <button type="submit" disabled={busy}>Salvează</button>
              <button type="button" onClick={() => { setGradeFor(null); setGradeValue('') }}>×</button>
            </form>
            : <button type="button" onClick={() => { setGradeFor(student.id); setGradeValue('') }}>Pune notă</button>)}
        </article>) : <div className="empty-catalog"><span aria-hidden="true">👥</span><strong>{emptyTitle}</strong><p>{emptyText}</p></div>}
      </div>
    </section>
  </div>
}
