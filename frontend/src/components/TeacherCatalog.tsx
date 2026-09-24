import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createLaboratory, createTeacherGroup, createTeacherStudent, deleteTeacherGroup, deleteTeacherStudent, errorMessage, isSessionExpired, loadAttendance, loadGroupStatistics, loadLabGrades, loadLaboratories, loadTeacherGroups, loadTeacherStudents,
  renameTeacherGroup, renameTeacherStudent, saveAttendance, saveLabGrade, type AttendanceStatus, type GroupStatistics, type LabGrade, type Laboratory, type TeacherGroup, type TeacherStudent,
} from '../api'
import { useDialog } from '../dialogs'
import { lessonsLabel } from '../labels'
import { formatDayMonth, universityClock } from '../schedule'
import { confirmAction } from '../telegram'

/** Mirrors backend groupSchema / studentSchema / grade limits. */
const LIMITS = { groupName: 80, subject: 120, personName: 80, laboratory: 120 } as const
const attendanceButtons: Array<{ status: AttendanceStatus, short: string, label: string }> = [
  { status: 'present', short: 'P', label: 'Prezent' }, { status: 'absent', short: 'A', label: 'Absent' }, { status: 'late', short: 'Î', label: 'Întârziat' },
]

/** The only place groups and students are ordered, so the list looks the same after loading, adding or renaming. */
const collator = new Intl.Collator('ro', { sensitivity: 'base', numeric: true })
const sortGroups = (items: TeacherGroup[]) => [...items].sort((a, b) => collator.compare(a.name, b.name))
const sortStudents = (items: TeacherStudent[]) => [...items].sort((a, b) => collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name))
const fullName = (student: TeacherStudent) => `${student.last_name} ${student.first_name}`
const sameGroupName = (a: string, b: string) => a.trim().toLocaleLowerCase('ro') === b.trim().toLocaleLowerCase('ro')
/** "PC · 2 ore în orar" / "Fără ore în orar"; null when the backend does not report the schedule link. */
const scheduleLink = (group: TeacherGroup) => {
  if (group.linkedLessons === undefined) return null
  if (!group.linkedLessons) return { subjects: '', count: 'Fără ore în orar' }
  return { subjects: group.subjects?.join(', ') ?? '', count: `${lessonsLabel(group.linkedLessons)} în orar` }
}
/** Subjects may be long and are truncated; the lesson count always stays visible. */
function ScheduleLink({ group, className }: { group: TeacherGroup, className: string }) {
  const link = scheduleLink(group)
  if (!link) return null
  return <small className={className} title={link.subjects ? `${link.subjects} · ${link.count}` : link.count}>
    {link.subjects && <><span className="link-subjects">{link.subjects}</span><span className="link-sep" aria-hidden="true">·</span></>}<span className="link-count">{link.count}</span>
  </small>
}
const formatGrade = (grade: number) => grade.toLocaleString('ro-RO', { maximumFractionDigits: 2 })
const formatPercent = (value: number, total: number) => total ? `${Math.round((value / total) * 100)}%` : '—'

function StatisticsPanel({ item, loading, failed, retry }: { item: GroupStatistics | null, loading: boolean, failed: boolean, retry(): void }) {
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  if (loading) return <p className="empty-catalog">Se încarcă statisticile…</p>
  if (failed || !item) return <p className="empty-catalog">Statisticile nu au putut fi încărcate. <button type="button" onClick={retry}>Reîncearcă</button></p>
  const { attendance, grades } = item
  return <section className="catalog-statistics" aria-label={`Statistici ${item.group.name}`}>
    <div className="stat-cards"><p><strong>{item.studentCount}</strong>studenți</p><p><strong>{attendance.sessionCount}</strong>sesiuni</p><p><strong>{formatPercent(attendance.presentCount, attendance.recordedCount)}</strong>prezenți din marcați</p><p><strong>{grades.average === null ? '—' : formatGrade(grades.average)}</strong>media notelor</p></div>
    <section><h3>Prezență</h3><p>P {attendance.presentCount} · A {attendance.absentCount} · Î {attendance.lateCount} · nemarcat {attendance.unmarkedCount}</p>{attendance.sessions.length ? <ul>{attendance.sessions.map((session) => <li key={session.date}><b>{formatDayMonth(session.date)}</b> — P {session.present}, A {session.absent}, Î {session.late}, nemarcat {session.unmarked}</li>)}</ul> : <p>Nicio sesiune salvată.</p>}</section>
    <section><h3>Lucrări și note</h3>{grades.laboratories.length ? <ul>{grades.laboratories.map((lab) => <li key={lab.id}><b>{lab.label}</b> — {lab.gradedCount}/{item.studentCount} notați, medie {lab.average === null ? '—' : formatGrade(lab.average)}</li>)}</ul> : <p>Nicio lucrare adăugată.</p>}</section>
    <section className="statistics-students"><h3>Elevi</h3><div>{item.students.map((student) => {
      const expanded = expandedStudent === student.id
      return <article key={student.id} className="statistics-student"><button type="button" className="statistics-student-toggle" onClick={() => setExpandedStudent(expanded ? null : student.id)} aria-expanded={expanded} aria-controls={`student-details-${student.id}`}><span>{student.lastName} {student.firstName}</span><small>P {student.present} · A {student.absent} · Î {student.late} · {student.gradedCount} note · media {student.average === null ? '—' : formatGrade(student.average)}</small></button>{expanded && <div id={`student-details-${student.id}`} className="student-detail"><p><strong>Absențe și întârzieri</strong></p>{student.attendanceEvents.length ? <ul>{student.attendanceEvents.map((event, index) => <li key={`${event.date}-${index}`}>{formatDayMonth(event.date)} — {event.status === 'absent' ? 'Absent' : 'Întârziat'}{event.topic ? ` · ${event.topic}` : ''}</li>)}</ul> : <p>Nicio absență sau întârziere salvată.</p>}<p><strong>Note</strong></p>{student.grades.length ? <ul>{student.grades.map((grade) => <li key={grade.id}><b>{grade.laboratory}</b>: {formatGrade(grade.grade)}{grade.presentedOn ? ` · ${formatDayMonth(grade.presentedOn)}` : ' · dată nespecificată'}</li>)}</ul> : <p>Nicio notă salvată.</p>}</div>}</article>
    })}</div></section>
  </section>
}

/** Keeps a form's submit button visible above the mobile keyboard once the viewport has shrunk. */
const revealSubmit = (event: FormEvent<HTMLFormElement>) => {
  const form = event.currentTarget
  window.setTimeout(() => form.querySelector('[type=submit]')?.scrollIntoView({ block: 'nearest' }), 350)
}

type Props = {
  mode: 'settings' | 'records', available: boolean, onClose(): void
  /** Opens on this group (matched case-insensitively), e.g. from a lesson card; groups created from lessons may need one re-fetch. */
  initialGroupName?: string
  /** A write answered 401/403: the app marks the whole session as expired. */
  onSessionExpired?(error: unknown): void
  /** The backend renamed the group in the Profesor lessons too; the app mirrors it. Returns how many lessons changed. */
  onGroupRenamed?(previousName: string, nextName: string): number
}
type GradesState = { studentId: string, items: LabGrade[], loading: boolean, failed: boolean }
type StudentDraft = { id: string, firstName: string, lastName: string }

export function TeacherCatalog({ mode, available, onClose, initialGroupName, onSessionExpired, onGroupRenamed }: Props) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  const isSettings = mode === 'settings'
  /** Day the catalog writes to; re-read before every write, because the panel can stay open past midnight. */
  const [today, setToday] = useState(() => universityClock().isoDate)
  const [groups, setGroups] = useState<TeacherGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(available)
  const [groupsReload, setGroupsReload] = useState(0)
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [selected, setSelected] = useState('')
  const [studentsState, setStudentsState] = useState<{ groupId: string, items: TeacherStudent[], failed: boolean }>({ groupId: '', items: [], failed: false })
  const [studentsReload, setStudentsReload] = useState(0)
  const [tab, setTab] = useState<'attendance' | 'grades' | 'statistics'>('attendance')
  const [message, setMessage] = useState(available ? '' : 'Catalogul este disponibil doar când aplicația este deschisă din Telegram.')
  const [busy, setBusy] = useState(false)
  const [showStudentForm, setShowStudentForm] = useState(false)
  const [showGroupForm, setShowGroupForm] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [groupName, setGroupName] = useState('')
  const [subject, setSubject] = useState('')
  const [groupDraft, setGroupDraft] = useState<string | null>(null)
  const [studentDraft, setStudentDraft] = useState<StudentDraft | null>(null)
  const [attendance, setAttendance] = useState<{ groupId: string, marks: Record<string, AttendanceStatus>, failed: boolean }>({ groupId: '', marks: {}, failed: false })
  const [attendanceReload, setAttendanceReload] = useState(0)
  const [laboratory, setLaboratory] = useState('')
  const [laboratories, setLaboratories] = useState<{ groupId: string, items: Laboratory[], loading: boolean, failed: boolean }>({ groupId: '', items: [], loading: false, failed: false })
  const [statistics, setStatistics] = useState<{ groupId: string, item: GroupStatistics | null, loading: boolean, failed: boolean }>({ groupId: '', item: null, loading: false, failed: false })
  const [grades, setGrades] = useState<GradesState | null>(null)
  const [gradeValue, setGradeValue] = useState('')
  /** Group still to be selected after the groups load, and whether the list was already re-fetched for it. */
  const pendingGroupRef = useRef(initialGroupName?.trim() ?? '')
  const pendingRetriedRef = useRef(false)
  /** Synchronous twin of `busy`: `busy` is only readable at the next render, too late for two quick taps. */
  const busyRef = useRef(false)
  /** A load failed and left its message on screen; only that same load clears it again. */
  const studentsFailedRef = useRef(false)
  const attendanceFailedRef = useRef(false)

  useEffect(() => {
    if (!available) return
    let active = true
    let retrying = false
    loadTeacherGroups()
      .then((items) => {
        if (!active) return
        const wanted = pendingGroupRef.current
        const match = wanted ? items.find((item) => sameGroupName(item.name, wanted)) : undefined
        // A group taken from a lesson is created by the server; if it is not listed yet, ask once more.
        if (wanted && !match && !pendingRetriedRef.current) {
          pendingRetriedRef.current = true
          retrying = true
          setGroupsReload((value) => value + 1)
          return
        }
        pendingGroupRef.current = ''
        setGroups(sortGroups(items)); setGroupsFailed(false)
        setSelected((current) => match ? match.id : current && items.some((item) => item.id === current) ? current : sortGroups(items)[0]?.id ?? '')
        setMessage(wanted && !match ? `Grupa „${wanted}” nu este încă în catalog.${isSettings ? ' O poți crea acum mai jos.' : ''}` : '')
        if (wanted && !match && isSettings) { setGroupName(wanted); setShowGroupForm(true) }
      })
      .catch((error) => {
        if (!active) return
        setGroupsFailed(true)
        setMessage(errorMessage(error, 'Catalogul nu este disponibil momentan. Încearcă din nou în câteva momente.'))
      })
      .finally(() => { if (active && !retrying) setGroupsLoading(false) })
    return () => { active = false }
  }, [available, groupsReload, isSettings])

  // Keep the selected group chip visible in the horizontal list (e.g. opened from a lesson card).
  useEffect(() => {
    if (selected) dialogRef.current?.querySelector('.existing-groups button.selected')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [selected, groups, dialogRef])

  useEffect(() => {
    if (!available || !selected) return
    let active = true
    loadTeacherStudents(selected)
      .then((items) => {
        if (!active) return
        setStudentsState({ groupId: selected, items: sortStudents(items), failed: false })
        // The error of another group must not stay on screen over a list that loaded fine.
        if (studentsFailedRef.current) { studentsFailedRef.current = false; setMessage('') }
      })
      .catch((error) => {
        if (!active) return
        setStudentsState({ groupId: selected, items: [], failed: true })
        studentsFailedRef.current = true
        setMessage(errorMessage(error, 'Nu s-au putut încărca studenții.'))
      })
    return () => { active = false }
  }, [available, selected, studentsReload])

  // Saved marks are always read back from the server, so reopening the catalog shows them.
  useEffect(() => {
    if (!available || isSettings || tab !== 'attendance' || !selected) return
    let active = true
    loadAttendance(selected, today)
      .then((saved) => {
        if (!active) return
        setAttendance({ groupId: selected, marks: Object.fromEntries(saved.entries.map((entry) => [entry.studentId, entry.status])), failed: false })
        if (attendanceFailedRef.current) { attendanceFailedRef.current = false; setMessage('') }
      })
      .catch((error) => {
        if (!active) return
        setAttendance({ groupId: selected, marks: {}, failed: true })
        attendanceFailedRef.current = true
        setMessage(errorMessage(error, 'Prezența salvată nu a putut fi încărcată.'))
      })
    return () => { active = false }
  }, [available, isSettings, tab, selected, today, attendanceReload])

  useEffect(() => {
    if (!available || isSettings || tab !== 'grades' || !selected) return
    let active = true
    loadLaboratories(selected).then((items) => {
      if (!active) return
      setLaboratories({ groupId: selected, items, loading: false, failed: false })
      setLaboratory((current) => items.some((item) => item.label === current) ? current : items[0]?.label ?? '')
    }).catch((error) => {
      if (!active) return
      setLaboratories({ groupId: selected, items: [], loading: false, failed: true })
      setMessage(errorMessage(error, 'Lucrările nu au putut fi încărcate.'))
    })
    return () => { active = false }
  }, [available, isSettings, tab, selected])

  useEffect(() => {
    if (!available || isSettings || tab !== 'statistics' || !selected) return
    let active = true
    loadGroupStatistics(selected).then((item) => {
      if (active) setStatistics({ groupId: selected, item, loading: false, failed: false })
    }).catch((error) => {
      if (!active) return
      setStatistics({ groupId: selected, item: null, loading: false, failed: true })
      setMessage(errorMessage(error, 'Statisticile nu au putut fi încărcate.'))
    })
    return () => { active = false }
  }, [available, isSettings, tab, selected])

  const studentsReady = Boolean(selected) && studentsState.groupId === selected
  const students = studentsReady ? studentsState.items : []
  const selectedGroup = groups.find((item) => item.id === selected)
  const attendanceReady = attendance.groupId === selected && !attendance.failed
  const laboratoriesLoading = laboratories.groupId !== selected || laboratories.loading
  const statisticsLoading = statistics.groupId !== selected || statistics.loading

  const reloadGroups = () => { setGroupsLoading(true); setMessage(''); setGroupsReload((value) => value + 1) }
  const reloadStudents = () => { setStudentsState({ groupId: '', items: [], failed: false }); setMessage(''); setStudentsReload((value) => value + 1) }
  const reloadAttendance = () => { setAttendance({ groupId: '', marks: {}, failed: false }); setMessage(''); setAttendanceReload((value) => value + 1) }
  /** Everything tied to the previous group is dropped, so a half-filled student form can never be submitted into another group. */
  const selectGroup = (groupId: string) => {
    setSelected(groupId); setGrades(null); setStudentDraft(null); setGroupDraft(null); setLaboratory('')
    setShowStudentForm(false); setFirstName(''); setLastName('')
    studentsFailedRef.current = false; attendanceFailedRef.current = false
    setMessage('')
  }

  /**
   * One write at a time. The guard is a ref because `busy` comes from the render that is already on screen,
   * and `confirm` runs inside the guard: two quick taps on Delete would otherwise open two confirmations.
   */
  const run = async (action: () => Promise<void>, fallback: string, confirm?: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      if (confirm && !await confirmAction(confirm)) return
      await action()
    } catch (error) {
      setMessage(errorMessage(error, fallback))
      if (isSessionExpired(error)) onSessionExpired?.(error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** Past midnight the displayed day is stale: refresh it (the attendance reloads) and let the caller warn. */
  const rolledOverDate = () => {
    const current = universityClock().isoDate
    if (current === today) return null
    setToday(current)
    setAttendance({ groupId: '', marks: {}, failed: false })
    return current
  }

  const addGroup = (event: FormEvent) => {
    event.preventDefault()
    if (groupName.trim().length < 2) return setMessage('Numele grupei trebuie să aibă cel puțin 2 caractere.')
    void run(async () => {
      const group = await createTeacherGroup(groupName, subject)
      setGroups((items) => sortGroups([...items, group]))
      selectGroup(group.id); setGroupName(''); setSubject(''); setShowGroupForm(false)
      setMessage(`Grupa ${group.name} a fost salvată.`)
    }, 'Grupa nu a fost salvată.')
  }

  const renameGroup = (event: FormEvent) => {
    event.preventDefault()
    if (!selectedGroup || groupDraft === null) return
    if (groupDraft.trim().length < 2) return setMessage('Numele grupei trebuie să aibă cel puțin 2 caractere.')
    const groupId = selectedGroup.id
    const previousName = selectedGroup.name
    void run(async () => {
      const group = await renameTeacherGroup(groupId, groupDraft)
      setGroups((items) => sortGroups(items.map((item) => item.id === groupId ? { ...item, ...group } : item)))
      setGroupDraft(null)
      // The server also renamed the group in the Profesor lessons; without this the schedule would keep the old name until a reload.
      const renamed = onGroupRenamed?.(previousName, group.name) ?? 0
      setMessage(`Grupa a fost redenumită în ${group.name}.${renamed ? ` ${lessonsLabel(renamed)} din orar ${renamed === 1 ? 'a fost actualizată' : 'au fost actualizate'}.` : ''}`)
    }, 'Grupa nu a fost redenumită.')
  }

  const removeGroup = async () => {
    if (!selectedGroup) return
    const group = selectedGroup
    const count = group.student_count === 1 ? '1 student' : `${group.student_count} studenți`
    await run(async () => {
      await deleteTeacherGroup(group.id)
      const rest = groups.filter((item) => item.id !== group.id)
      setGroups(rest); selectGroup(rest[0]?.id ?? '')
      setMessage(`Grupa ${group.name} a fost ștearsă.`)
    }, 'Grupa nu a fost ștearsă.', `Ștergi grupa „${group.name}”? Se șterg definitiv ${count}, prezența și notele lor.`)
  }

  const addStudent = (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    if (!firstName.trim() || !lastName.trim()) return setMessage('Completează numele și prenumele studentului.')
    const groupId = selected
    void run(async () => {
      const student = await createTeacherStudent(groupId, firstName, lastName)
      setStudentsState((state) => state.groupId === groupId ? { ...state, items: sortStudents([...state.items, student]) } : state)
      setGroups((items) => items.map((item) => item.id === groupId ? { ...item, student_count: item.student_count + 1 } : item))
      setFirstName(''); setLastName(''); setShowStudentForm(false)
      setMessage('Studentul a fost adăugat.')
    }, 'Studentul nu a fost salvat.')
  }

  const renameStudent = (event: FormEvent) => {
    event.preventDefault()
    if (!studentDraft) return
    if (!studentDraft.firstName.trim() || !studentDraft.lastName.trim()) return setMessage('Completează numele și prenumele studentului.')
    const draft = studentDraft
    void run(async () => {
      const student = await renameTeacherStudent(draft.id, draft.firstName, draft.lastName)
      setStudentsState((state) => ({ ...state, items: sortStudents(state.items.map((item) => item.id === student.id ? student : item)) }))
      setStudentDraft(null)
      setMessage(`Studentul a fost redenumit: ${fullName(student)}.`)
    }, 'Studentul nu a fost redenumit.')
  }

  const removeStudent = async (student: TeacherStudent) => {
    const groupId = selected
    await run(async () => {
      await deleteTeacherStudent(student.id)
      setStudentsState((state) => ({ ...state, items: state.items.filter((item) => item.id !== student.id) }))
      setGroups((items) => items.map((item) => item.id === groupId ? { ...item, student_count: Math.max(item.student_count - 1, 0) } : item))
      setMessage(`Studentul ${fullName(student)} a fost șters.`)
    }, 'Studentul nu a fost șters.', `Ștergi studentul ${fullName(student)}? Se șterg definitiv și prezența și notele lui.`)
  }

  const markAttendance = (student: TeacherStudent, status: AttendanceStatus) => {
    if (!selected) return
    const newDate = rolledOverDate()
    if (newDate) return setMessage(`Ziua s-a schimbat între timp. Acum completezi prezența pentru ${formatDayMonth(newDate)} — am reîncărcat-o, marchează din nou.`)
    const groupId = selected
    void run(async () => {
      // Only this student's entry is sent, so earlier marks for other students are not overwritten.
      await saveAttendance(groupId, [{ studentId: student.id, status }], today)
      setAttendance((state) => state.groupId === groupId ? { ...state, marks: { ...state.marks, [student.id]: status } } : state)
      setMessage(`Prezența pentru ${fullName(student)} a fost salvată.`)
    }, 'Prezența nu a fost salvată.')
  }

  const openGrades = (student: TeacherStudent) => {
    setGradeValue('')
    setGrades({ studentId: student.id, items: [], loading: true, failed: false })
    const matches = (state: GradesState | null) => state?.studentId === student.id
    loadLabGrades(student.id)
      .then((items) => setGrades((state) => matches(state) ? { studentId: student.id, items, loading: false, failed: false } : state))
      .catch((error) => {
        setGrades((state) => matches(state) ? { studentId: student.id, items: [], loading: false, failed: true } : state)
        setMessage(errorMessage(error, 'Notele nu au putut fi încărcate.'))
      })
  }

  const addLaboratory = () => {
    if (!selected) return
    const groupId = selected
    void run(async () => {
      const created = await createLaboratory(groupId)
      setLaboratories((state) => state.groupId === groupId ? { ...state, items: [...state.items, created].sort((a, b) => a.number - b.number) } : state)
      setLaboratory(created.label)
      setMessage(`${created.label} a fost adăugat pentru această grupă.`)
    }, 'Lucrarea nu a fost adăugată.')
  }

  const submitGrade = (event: FormEvent, student: TeacherStudent) => {
    event.preventDefault()
    const score = Number(gradeValue.replace(',', '.'))
    if (gradeValue.trim() === '' || !Number.isFinite(score) || score < 0 || score > 10) return setMessage('Nota trebuie să fie un număr între 0 și 10.')
    if (!laboratory.trim()) return setMessage('Adaugă sau alege mai întâi o lucrare.')
    // The grade is stamped with the current date by the API; keep the displayed day in step with it.
    rolledOverDate()
    void run(async () => {
      const saved = await saveLabGrade(student.id, laboratory, Math.round(score * 100) / 100)
      // One grade per laboratory: a repeated save replaces the previous one.
      setGrades((state) => state?.studentId === student.id ? { ...state, items: [...state.items.filter((item) => item.laboratory !== saved.laboratory), saved] } : state)
      setGradeValue('')
      setMessage(`Nota ${formatGrade(saved.grade)} (${saved.laboratory}) pentru ${fullName(student)} a fost salvată.`)
    }, 'Nota nu a fost salvată.')
  }

  const noGroups = available && !groupsLoading && !groupsFailed && !groups.length
  const emptyTitle = groupsLoading ? 'Se încarcă grupele…' : noGroups ? 'Nu ai încă grupe' : !selected ? 'Alege o grupă' : !studentsReady ? 'Se încarcă studenții…'
    : studentsState.failed ? 'Studenții nu au fost încărcați' : 'Lista este goală'
  const emptyText = groupsLoading || (selected && !studentsReady) ? 'Un moment, te rog.'
    : noGroups ? (isSettings ? 'Apasă „Creează grupă” pentru a începe.' : 'Creează o grupă din Profil → Setări grupe, apoi revino aici.')
      : !selected ? 'Selectează o grupă pentru a vedea catalogul.'
        : studentsState.failed ? 'Verifică conexiunea și încearcă din nou.'
          : isSettings ? 'Adaugă primul student pentru a începe evidența.' : 'Adaugă studenți din Profil → Setări grupe.'
  const currentLab = laboratory.trim()

  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="catalog-panel" role="dialog" aria-modal="true" aria-labelledby="catalog-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>{isSettings ? 'PROFIL PROFESOR · SETĂRI' : 'CATALOG PROFESOR · EVIDENȚĂ'}</p><h2 id="catalog-title">{isSettings ? 'Setări grupe' : 'Prezență și note'}</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <p className="catalog-subtitle">{isSettings ? 'Creezi grupe și adaugi studenți în grupele existente.' : `Selectezi grupa și completezi prezența (pentru ${formatDayMonth(today)}) sau notele de laborator.`}</p>
      <div className="catalog-toolbar">
        <select value={selected} onChange={(e) => selectGroup(e.target.value)} disabled={!available || groupsLoading} aria-label="Grupa">
          <option value="">{groupsLoading ? 'Se încarcă…' : 'Alege grupa'}</option>
          {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {isSettings && available && <button type="button" onClick={() => setShowGroupForm(true)}>＋ Creează grupă</button>}
        {available && !groupsLoading && groupsFailed && <button type="button" onClick={reloadGroups}>Reîncearcă</button>}
      </div>
      {!isSettings && selectedGroup && scheduleLink(selectedGroup) && <p className="catalog-link-info"><span aria-hidden="true">🗓</span> <ScheduleLink group={selectedGroup} className="catalog-link" /></p>}
      {isSettings && groups.length > 0 && <section className="existing-groups" aria-label="Grupe existente">
        <header>
          <strong>Grupele mele</strong>
          {selectedGroup && groupDraft === null && <span>
            <button type="button" onClick={() => setGroupDraft(selectedGroup.name)} disabled={busy}>✎ Redenumește</button>
            <button type="button" className="danger" onClick={removeGroup} disabled={busy}>Șterge</button>
          </span>}
        </header>
        <div>{groups.map((item) => <button type="button" className={item.id === selected ? 'selected' : ''} aria-pressed={item.id === selected} key={item.id} onClick={() => selectGroup(item.id)}><span aria-hidden="true">👥</span><span className="group-chip-text">{item.name}<ScheduleLink group={item} className="group-chip-link" /></span><small>{item.student_count} stud.</small></button>)}</div>
      </section>}
      {isSettings && selectedGroup && groupDraft !== null && <form className="catalog-form" onSubmit={renameGroup} onFocus={revealSubmit}>
        <strong>Redenumește grupa {selectedGroup.name}</strong>
        <input autoFocus required minLength={2} maxLength={LIMITS.groupName} value={groupDraft} onChange={(e) => setGroupDraft(e.target.value)} aria-label="Numele nou al grupei" />
        <div><button type="button" onClick={() => setGroupDraft(null)}>Anulează</button><button type="submit" disabled={busy}>Salvează</button></div>
      </form>}
      {isSettings && showGroupForm && <form className="catalog-form" onSubmit={addGroup} onFocus={revealSubmit}>
        <strong>Grupă nouă</strong>
        <input autoFocus required minLength={2} maxLength={LIMITS.groupName} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="ex. SI-265 PC" aria-label="Numele grupei" />
        <input maxLength={LIMITS.subject} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Disciplina (opțional)" aria-label="Disciplina" />
        <div><button type="button" onClick={() => setShowGroupForm(false)}>Anulează</button><button type="submit" disabled={busy}>Salvează grupa</button></div>
      </form>}
      {!isSettings && <nav className="catalog-tabs" aria-label="Tip evidență">
        <button type="button" className={tab === 'attendance' ? 'active' : ''} aria-pressed={tab === 'attendance'} onClick={() => setTab('attendance')}>Prezență</button>
        <button type="button" className={tab === 'grades' ? 'active' : ''} aria-pressed={tab === 'grades'} onClick={() => setTab('grades')}>Note</button>
        <button type="button" className={tab === 'statistics' ? 'active' : ''} aria-pressed={tab === 'statistics'} onClick={() => setTab('statistics')}>Statistici</button>
      </nav>}
      {!isSettings && tab === 'grades' && studentsReady && students.length > 0 && <form className="catalog-form" onSubmit={(e) => e.preventDefault()}>
        <strong>Lucrare</strong>
        <div className="form-row"><select value={laboratory} onChange={(e) => setLaboratory(e.target.value)} aria-label="Lucrarea selectată" disabled={laboratoriesLoading || laboratories.failed || busy}><option value="">{laboratoriesLoading ? 'Se încarcă…' : 'Alege lucrarea'}</option>{laboratories.items.map((item) => <option key={item.id} value={item.label}>{item.label}</option>)}</select><button type="button" onClick={addLaboratory} disabled={busy || laboratoriesLoading}>＋ Adaugă lucrare</button></div>
        {laboratories.failed && <button type="button" onClick={() => setTab('attendance')}>Reîncearcă după reselectarea filei Note</button>}
      </form>}
      {message && <p className="catalog-message" role="status">{message}</p>}
      {!isSettings && tab === 'attendance' && attendance.groupId === selected && attendance.failed && studentsReady && students.length > 0 &&
        <button type="button" className="catalog-retry" onClick={reloadAttendance}>Reîncearcă încărcarea prezenței</button>}
      {!isSettings && tab === 'statistics' ? <StatisticsPanel item={statistics.groupId === selected ? statistics.item : null} loading={statisticsLoading} failed={statistics.groupId === selected && statistics.failed} retry={() => { setStatistics({ groupId: '', item: null, loading: false, failed: false }); setTab('attendance'); window.setTimeout(() => setTab('statistics'), 0) }} /> : <div className="student-list">
        {isSettings && available && <>
          {!showStudentForm && <button type="button" className="add-student" disabled={!selected} onClick={() => setShowStudentForm(true)}>＋ Adaugă student</button>}
          {showStudentForm && <form className="catalog-form" onSubmit={addStudent} onFocus={revealSubmit}>
            <strong>Student nou</strong>
            <div className="form-row">
              <input autoFocus required maxLength={LIMITS.personName} value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Nume" aria-label="Nume" />
              <input required maxLength={LIMITS.personName} value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Prenume" aria-label="Prenume" />
            </div>
            <div><button type="button" onClick={() => setShowStudentForm(false)}>Anulează</button><button type="submit" disabled={busy}>Adaugă studentul</button></div>
          </form>}
        </>}
        {students.length ? students.map((student, index) => {
          const gradesOpen = !isSettings && tab === 'grades' && grades?.studentId === student.id
          if (isSettings && studentDraft?.id === student.id) {
            return <form key={student.id} className="catalog-form" onSubmit={renameStudent} onFocus={revealSubmit}>
              <strong>Redenumește studentul</strong>
              <div className="form-row">
                <input autoFocus required maxLength={LIMITS.personName} value={studentDraft.lastName} onChange={(e) => setStudentDraft({ ...studentDraft, lastName: e.target.value })} placeholder="Nume" aria-label="Nume" />
                <input required maxLength={LIMITS.personName} value={studentDraft.firstName} onChange={(e) => setStudentDraft({ ...studentDraft, firstName: e.target.value })} placeholder="Prenume" aria-label="Prenume" />
              </div>
              <div><button type="button" onClick={() => setStudentDraft(null)}>Anulează</button><button type="submit" disabled={busy}>Salvează</button></div>
            </form>
          }
          return <article key={student.id} className={gradesOpen ? 'expanded' : undefined}>
            <b>{index + 1}</b>
            <span>{fullName(student)}</span>
            {isSettings && <div className="row-actions">
              <button type="button" className="row-action" disabled={busy} aria-label={`Redenumește ${fullName(student)}`} title="Redenumește" onClick={() => setStudentDraft({ id: student.id, firstName: student.first_name, lastName: student.last_name })}>✎</button>
              <button type="button" className="row-action danger" disabled={busy} aria-label={`Șterge ${fullName(student)}`} title="Șterge" onClick={() => removeStudent(student)}>🗑</button>
            </div>}
            {!isSettings && tab === 'attendance' && <div role="group" aria-label={`Prezența: ${fullName(student)}`}>
              {attendanceButtons.map((item) => {
                const active = attendanceReady && attendance.marks[student.id] === item.status
                return <button type="button" key={item.status} className={active ? 'selected' : ''} aria-pressed={active} title={item.label} aria-label={item.label} disabled={busy || !attendanceReady} onClick={() => markAttendance(student, item.status)}>{item.short}</button>
              })}
            </div>}
            {!isSettings && tab === 'grades' && <button type="button" aria-expanded={gradesOpen} onClick={() => gradesOpen ? setGrades(null) : openGrades(student)}>{gradesOpen ? 'Ascunde' : 'Note'}</button>}
            {gradesOpen && grades && <div className="student-grades">
              {grades.loading ? <p>Se încarcă notele…</p>
                : grades.failed ? <p>Notele nu au putut fi încărcate. <button type="button" onClick={() => openGrades(student)}>Reîncearcă</button></p>
                  : grades.items.length ? <ul aria-label={`Notele: ${fullName(student)}`}>{grades.items.map((item) => <li key={item.id} className={item.laboratory === currentLab ? 'current' : ''}>{item.laboratory}: <b>{formatGrade(item.grade)}</b></li>)}</ul>
                    : <p>Nicio notă salvată.</p>}
              <form className="grade-form" onSubmit={(e) => submitGrade(e, student)}>
                <input autoFocus inputMode="decimal" type="number" min={0} max={10} step={0.01} value={gradeValue} onChange={(e) => setGradeValue(e.target.value)} aria-label={`Nota pentru ${fullName(student)}`} placeholder="0–10" />
                <button type="submit" disabled={busy || grades.loading}>{grades.items.some((item) => item.laboratory === currentLab) ? 'Înlocuiește' : 'Salvează'}</button>
              </form>
            </div>}
          </article>
        }) : <div className="empty-catalog">
          <span aria-hidden="true">👥</span><strong>{emptyTitle}</strong><p>{emptyText}</p>
          {studentsReady && studentsState.failed && <button type="button" className="catalog-retry" onClick={reloadStudents}>Reîncearcă</button>}
        </div>}
      </div>}
    </section>
  </div>
}
