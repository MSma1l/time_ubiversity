import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteLessonRemote, devTelegramId, errorMessage, loadAccount, markNotificationsRead, saveLessonRemote, updateLessonRemote, updateProfileState, updateRole } from './api'
import { BellIcon, LessonCard } from './components/LessonCard'
import { LessonEditor } from './components/LessonEditor'
import { CalendarPanel, NotificationPanel, ProfilePanel } from './components/Panels'
import { TeacherCatalog } from './components/TeacherCatalog'
import { initialOf, minutesLabel, roleLabels } from './labels'
import { addDays, byStartTime, dayOfMonth, demoLessons, formatDayMonth, lessonMatchesWeek, timeToMinutes, universityClock, weekdayNames, weekTypeFor } from './schedule'
import { confirmAction, detectSession } from './telegram'
import type { AppNotification, Lesson, Role } from './types'

type SyncState = 'loading' | 'ready' | 'error' | 'demo'
type Notice = { kind: 'success' | 'error', text: string }

const NOTICE_TIMEOUT_MS = 5_000
const CLOCK_TICK_MS = 30_000
const demoNotifications: AppNotification[] = [{ id: 1, kind: 'system', title: 'Bine ai venit în Orar Univer', body: 'Configurează orele și vei primi memento-uri direct în Telegram.', readAt: null, createdAt: new Date().toISOString() }]

export function App() {
  const [session] = useState(() => detectSession(devTelegramId))
  if (session.mode === 'none') return <OpenInTelegram />
  return <Schedule initialName={session.name} demo={session.mode === 'demo'} />
}

function OpenInTelegram() {
  return <main className="app-shell">
    <header className="topbar"><div><p className="eyebrow">ORAR UNIVER</p><h1>Bună <span aria-hidden="true">👋</span></h1></div></header>
    <section className="empty" role="alert">
      <span aria-hidden="true">📱</span>
      <h3>Deschide aplicația din Telegram</h3>
      <p>Orar Univer funcționează ca Mini App în Telegram. Deschide-o din botul universității pentru a-ți vedea și sincroniza orarul.</p>
    </section>
  </main>
}

function Schedule({ initialName, demo }: { initialName: string, demo: boolean }) {
  const [now, setNow] = useState(() => new Date())
  const today = useMemo(() => universityClock(now), [now])
  const week = weekTypeFor(today.isoDate)
  const [role, setRole] = useState<Role>('student')
  const [activeDay, setActiveDay] = useState(today.weekdayIndex)
  const [lessons, setLessons] = useState<Lesson[]>(demo ? demoLessons : [])
  const [notifications, setNotifications] = useState<AppNotification[]>(demo ? demoNotifications : [])
  const [roleEnabled, setRoleEnabled] = useState<Record<Role, boolean>>({ student: true, teacher: true })
  const [name, setName] = useState(initialName)
  const [syncState, setSyncState] = useState<SyncState>(demo ? 'demo' : 'loading')
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editor, setEditor] = useState<{ lesson: Lesson | null, slot: { day: number, time: string } | null } | null>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false)
  const lastDateRef = useRef(today.isoDate)

  const synced = syncState === 'ready'
  const success = (text: string) => setNotice({ kind: 'success', text })
  const failure = (text: string) => setNotice({ kind: 'error', text })

  // Keep "now" fresh; when the university date changes, jump to the new day.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = new Date()
      const clock = universityClock(current)
      if (clock.isoDate !== lastDateRef.current) { lastDateRef.current = clock.isoDate; setActiveDay(clock.weekdayIndex) }
      setNow(current)
    }, CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (demo) return
    let active = true
    loadAccount()
      .then(({ profile, lessons: savedLessons, notifications: savedNotifications }) => {
        if (!active) return
        setName((current) => profile.displayName || current)
        setRole(profile.role)
        setRoleEnabled({ student: profile.studentEnabled, teacher: profile.teacherEnabled })
        setLessons(savedLessons)
        setNotifications(savedNotifications)
        setSyncState('ready')
      })
      .catch((error) => {
        if (!active) return
        setLoadError(errorMessage(error, 'Nu s-a putut încărca orarul.'))
        setSyncState('error')
      })
    return () => { active = false }
  }, [demo, reloadKey])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const retryLoad = () => { setSyncState('loading'); setLoadError(''); setReloadKey((value) => value + 1) }

  const displayedLessons = useMemo(() => lessons.filter((item) => item.role === role && item.weekday === activeDay && lessonMatchesWeek(item, week)).sort(byStartTime), [activeDay, lessons, role, week])

  const nextLesson = useMemo(() => {
    const roleLessons = lessons.filter((item) => item.role === role)
    // Look two weeks ahead: week parity changes after Sunday.
    for (let offset = 0; offset < 14; offset += 1) {
      const isoDate = addDays(today.isoDate, offset)
      const dayWeek = weekTypeFor(isoDate)
      const weekday = (today.weekdayIndex + offset) % 7
      const match = roleLessons
        .filter((item) => item.weekday === weekday && lessonMatchesWeek(item, dayWeek) && (offset > 0 || timeToMinutes(item.startTime) > today.minutes))
        .sort(byStartTime)[0]
      if (match) return { lesson: match, label: offset === 0 ? 'Azi' : offset === 1 ? 'Mâine' : weekdayNames[weekday] }
    }
    return null
  }, [lessons, role, today])

  const reminderStatus = useMemo(() => {
    const roleLessons = lessons.filter((item) => item.role === role)
    const active = roleLessons.filter((item) => item.notificationsEnabled)
    if (!roleLessons.length) return { title: 'Notificări', text: 'Adaugă ore pentru a primi memento-uri în Telegram.' }
    if (!active.length) return { title: 'Notificări oprite', text: 'Nicio oră nu are memento. Îl poți activa din editorul orei.' }
    const before = (minutes: number) => minutes === 0 ? 'la începutul' : `cu ${minutesLabel(minutes)} înainte de`
    const title = active.length === roleLessons.length ? 'Notificări active' : `Notificări active pentru ${active.length} din ${roleLessons.length} ore`
    const minutes = new Set(active.map((item) => item.reminderMinutes))
    if (active.length === roleLessons.length && minutes.size === 1) return { title, text: `Îți amintim ${before(active[0].reminderMinutes)} fiecare oră.` }
    const next = nextLesson?.lesson
    if (next) return { title, text: next.notificationsEnabled ? `Îți amintim ${before(next.reminderMinutes)} următoarea oră.` : 'Următoarea oră nu are memento.' }
    return { title, text: 'Memento-ul fiecărei ore se setează din editorul orei.' }
  }, [lessons, nextLesson, role])

  /** Returns false (and shows why) when a change cannot be persisted right now. */
  const ensureWritable = () => {
    if (synced || syncState === 'demo') return true
    failure(syncState === 'loading' ? 'Orarul încă se încarcă. Încearcă în câteva secunde.' : 'Orarul nu este sincronizat. Apasă „Reîncearcă” mai întâi.')
    return false
  }

  const saveLesson = async (lesson: Lesson, isNew: boolean) => {
    if (!ensureWritable()) return false
    try {
      const saved = synced ? await (isNew ? saveLessonRemote(lesson) : updateLessonRemote(lesson)) : lesson
      setLessons((items) => isNew ? [...items, saved] : items.map((item) => item.id === lesson.id ? saved : item))
      setEditor(null)
      success(isNew ? (synced ? 'Ora a fost salvată și se va sincroniza cu botul.' : 'Ora a fost adăugată doar local (mod demonstrativ).') : 'Ora a fost modificată.')
      return true
    } catch (error) {
      failure(errorMessage(error, isNew ? 'Ora nu a putut fi salvată. Încearcă din nou.' : 'Modificarea nu a putut fi salvată.'))
      return false
    }
  }

  const removeLesson = async (lesson: Lesson) => {
    if (!ensureWritable() || !(await confirmAction(`Ștergi „${lesson.title}”?`))) return
    try {
      if (synced) await deleteLessonRemote(lesson.id)
      setLessons((items) => items.filter((item) => item.id !== lesson.id))
      setEditor(null)
      success('Ora a fost ștearsă.')
    } catch (error) {
      failure(errorMessage(error, 'Ora nu a putut fi ștearsă.'))
    }
  }

  const openNewLesson = (day = activeDay, time = '08:00') => setEditor({ lesson: null, slot: { day: Math.min(day, weekdayNames.length - 1), time } })
  const openLesson = (lesson: Lesson) => setEditor({ lesson, slot: null })

  const chooseRole = async (next: Role) => {
    if (next === role) return
    if (!roleEnabled[next]) { failure(`Modul ${roleLabels[next]} este dezactivat. Activează-l din Profil.`); return }
    const previous = role
    setRole(next)
    try { if (synced) await updateRole(next) } catch (error) { setRole(previous); failure(errorMessage(error, 'Rolul nu a putut fi actualizat.')) }
  }

  const toggleRoleEnabled = async (kind: Role) => {
    const next = !roleEnabled[kind]
    const other: Role = kind === 'student' ? 'teacher' : 'student'
    if (!next && !roleEnabled[other]) { failure('Cel puțin un mod trebuie să rămână activ.'); return }
    setRoleEnabled((value) => ({ ...value, [kind]: next }))
    if (!next && role === kind) setRole(other)
    try {
      if (synced) {
        await updateProfileState(kind === 'student' ? { studentEnabled: next } : { teacherEnabled: next })
        if (!next && role === kind) await updateRole(other)
      }
    } catch (error) {
      setRoleEnabled((value) => ({ ...value, [kind]: !next }))
      if (!next && role === kind) setRole(kind)
      failure(errorMessage(error, 'Starea nu a putut fi actualizată.'))
    }
  }

  const openNotifications = async () => {
    setNotificationsOpen(true)
    if (!notifications.some((item) => !item.readAt)) return
    try {
      if (synced) await markNotificationsRead()
      else if (syncState !== 'demo') return
      const readAt = new Date().toISOString()
      setNotifications((items) => items.map((item) => ({ ...item, readAt: item.readAt ?? readAt })))
    } catch (error) {
      failure(errorMessage(error, 'Notificările nu au putut fi marcate ca citite.'))
    }
  }

  const dateForDay = (dayIndex: number) => addDays(today.isoDate, dayIndex - today.weekdayIndex)
  const unreadCount = notifications.filter((item) => !item.readAt).length
  const isToday = activeDay === today.weekdayIndex

  return <main className="app-shell">
    <header className="topbar">
      <div><p className="eyebrow">ORAR UNIVER</p><h1>{name ? `Bună, ${name}` : 'Bună'} <span aria-hidden="true">👋</span></h1></div>
      <button type="button" className="avatar" onClick={() => setProfileOpen(true)} aria-label="Deschide profilul">{initialOf(name)}</button>
    </header>
    {demo && <p className="sync demo-banner" role="note">Mod demonstrativ: date de exemplu, nimic nu se salvează pe server.</p>}

    <section className="overview" aria-label="Săptămâna curentă">
      <div>
        <span className={`week-badge ${week}`}>{week === 'even' ? 'Săptămână pară' : 'Săptămână impară'}</span>
        <h2>Programul tău,<br />fără griji.</h2>
        <p>Calculat automat pentru data curentă, de la referința 7–13 septembrie 2026.</p>
      </div>
      <div className="next-class" aria-label="Următoarea oră">
        <span>URMĂTOAREA ORĂ</span>
        {nextLesson ? <><b>{nextLesson.lesson.startTime}</b><small>{nextLesson.lesson.title}</small><em>{nextLesson.label}</em></> : <><b>—</b><small>Nu ai ore planificate</small></>}
      </div>
    </section>

    <section className="role-card" aria-label="Rol activ">
      <div><span className="role-icon" aria-hidden="true">{role === 'student' ? '🎓' : '🧑‍🏫'}</span><div><strong>{roleLabels[role]}</strong><small>{role === 'student' ? 'Vezi orele grupei tale' : 'Gestionează orele predate'}</small></div></div>
      <div className="role-switch" role="group" aria-label="Alege rolul">
        {(['student', 'teacher'] as const).map((kind) => <button type="button" key={kind} className={role === kind ? 'selected' : ''} aria-pressed={role === kind} onClick={() => chooseRole(kind)}>{roleLabels[kind]}</button>)}
      </div>
    </section>

    <nav className="day-tabs" aria-label="Alege ziua">
      {weekdayNames.map((day, index) => <button type="button" key={day} className={activeDay === index ? 'active' : ''} aria-pressed={activeDay === index} aria-label={`${day} ${formatDayMonth(dateForDay(index))}`} onClick={() => setActiveDay(index)}><span>{day.slice(0, 2)}</span><b>{dayOfMonth(dateForDay(index))}</b></button>)}
    </nav>

    <section className="schedule" aria-labelledby="schedule-heading">
      <div className="section-heading">
        <div><p>{weekdayNames[activeDay]}, {formatDayMonth(dateForDay(activeDay))}</p><h2 id="schedule-heading">Orele tale</h2></div>
        <button type="button" className="add-button" onClick={() => openNewLesson()} aria-label="Adaugă o oră">+</button>
      </div>
      {syncState === 'loading' && <p className="sync" role="status">Se conectează la orarul tău…</p>}
      {notice && <p className={notice.kind === 'success' ? 'success' : 'error-notice'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.kind === 'success' ? '✓ ' : '⚠ '}{notice.text}</p>}
      {syncState === 'error' ? <div className="empty" role="alert">
        <span aria-hidden="true">⚠️</span><h3>Orarul nu a putut fi încărcat</h3><p>{loadError}</p><button type="button" onClick={retryLoad}>Reîncearcă</button>
      </div> : syncState === 'loading' ? null : displayedLessons.length ? <div className="timeline">
        {displayedLessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} role={role} onEdit={() => openLesson(lesson)} />)}
      </div> : <div className="empty free-day">
        <span aria-hidden="true">☀️</span><h3>{isToday ? 'Ești liber azi' : 'Zi liberă'}</h3><p>Nu ai nicio pereche în această zi. Bucură-te de timp liber!</p><button type="button" onClick={() => openNewLesson()}>Adaugă o activitate</button>
      </div>}
    </section>

    <section className="reminder"><span aria-hidden="true">🔔</span><div><strong>{reminderStatus.title}</strong><p>{reminderStatus.text}</p></div><button type="button" onClick={openNotifications}>{unreadCount ? `Vezi (${unreadCount})` : 'Vezi'}</button></section>

    <footer aria-label="Navigare principală">
      <button type="button" className="nav-item active" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-current="page"><span aria-hidden="true">⌂</span><small>Acasă</small></button>
      <button type="button" className="nav-item" onClick={() => setCalendarOpen(true)}><span aria-hidden="true">▤</span><small>Orar</small></button>
      <button type="button" className="nav-add" onClick={() => openNewLesson()} aria-label="Adaugă oră">＋</button>
      <button type="button" className="nav-item footer-notifications" onClick={openNotifications} aria-label={unreadCount ? `Notificări, ${unreadCount} necitite` : 'Notificări'}><BellIcon /><small>Notificări</small>{unreadCount ? <i aria-hidden="true">{unreadCount}</i> : null}</button>
      {role === 'teacher' && <button type="button" className="nav-item" onClick={() => setCatalogOpen(true)}><span aria-hidden="true">▦</span><small>Evidență</small></button>}
      <button type="button" className="nav-item" onClick={() => setProfileOpen(true)}><span aria-hidden="true">◌</span><small>Profil</small></button>
    </footer>

    {calendarOpen && <CalendarPanel lessons={lessons} role={role} week={week} onClose={() => setCalendarOpen(false)} onAdd={openNewLesson} onEdit={(lesson) => { setCalendarOpen(false); openLesson(lesson) }} />}
    {editor && <LessonEditor key={editor.lesson?.id ?? 'new'} role={role} existing={editor.lesson} slot={editor.slot} onClose={() => setEditor(null)}
      onSave={(lesson) => saveLesson(lesson, !editor.lesson)} onDelete={editor.lesson ? () => removeLesson(editor.lesson as Lesson) : undefined} />}
    {notificationsOpen && <NotificationPanel items={notifications} onClose={() => setNotificationsOpen(false)} />}
    {profileOpen && <ProfilePanel name={name} role={role} week={week} enabled={roleEnabled} synced={synced} onClose={() => setProfileOpen(false)}
      onSwitchRole={() => chooseRole(role === 'student' ? 'teacher' : 'student')} onToggle={toggleRoleEnabled} onOpenGroupSettings={() => { setProfileOpen(false); setGroupSettingsOpen(true) }} />}
    {groupSettingsOpen && <TeacherCatalog mode="settings" available={synced} onClose={() => setGroupSettingsOpen(false)} />}
    {catalogOpen && <TeacherCatalog mode="records" available={synced} onClose={() => setCatalogOpen(false)} />}
  </main>
}
