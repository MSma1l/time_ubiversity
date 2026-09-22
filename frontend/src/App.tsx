import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, deleteLessonRemote, devTelegramId, errorMessage, isSessionExpired, loadAccount, loadNotifications, loadTeacherGroups, loadWeekCalendar, markNotificationsRead, saveLessonRemote, updateLessonRemote, updateProfileState, updateRole } from './api'
import { BellIcon, LessonCard } from './components/LessonCard'
import { LessonEditor, type EditorFailure } from './components/LessonEditor'
import { CalendarPanel, NotificationPanel, ProfilePanel, WeekNav } from './components/Panels'
import { TeacherCatalog } from './components/TeacherCatalog'
import { initialOf, minutesLabel, roleLabels } from './labels'
import { activeSemesters, addDays, byStartTime, currentInstant, dayOfMonth, demoLessons, formatDayMonth, formatWeekRange, installSemesters, isStudyDay, lessonMatchesWeek, lessonTiming, mondayOf, semesterAnchorOf, timeToMinutes, universityClock, weekdayNames, weekTypeFor, weekTypeLabels } from './schedule'
import { confirmAction, detectSession } from './telegram'
import type { AccountProfile } from './api'
import type { Semester } from './schedule'
import type { AppNotification, Lesson, Role } from './types'

type SyncState = 'loading' | 'ready' | 'error' | 'demo'
type Notice = { kind: 'success' | 'error', text: string }

const NOTICE_TIMEOUT_MS = 5_000
const CLOCK_TICK_MS = 30_000
/** Notifications are re-fetched when the app becomes visible again, at most once in this interval. */
const NOTIFICATIONS_REFRESH_MIN_MS = 15_000
const VISIBILITY_DEBOUNCE_MS = 400
const otherRole = (value: Role): Role => value === 'student' ? 'teacher' : 'student'

/** Server notifications win, but a read mark set locally (request still in flight) is kept. */
function mergeNotifications(local: AppNotification[], server: AppNotification[]) {
  const readLocally = new Map(local.filter((item) => item.readAt).map((item) => [item.id, item.readAt]))
  return server.map((item) => item.readAt || !readLocally.has(item.id) ? item : { ...item, readAt: readLocally.get(item.id) ?? null })
}

type RoleState = { role: Role, enabled: Record<Role, boolean> }
/** Never both modes disabled, and the active role is always an enabled one. */
function consistentRoles({ role, enabled }: RoleState): RoleState {
  const safe = enabled.student || enabled.teacher ? enabled : { ...enabled, student: true }
  return { role: safe[role] ? role : otherRole(role), enabled: safe }
}
/** Same rule as `groupKey` in backend/src/groupSync.ts: a lesson belongs to a catalog group by trimmed, case-insensitive name. */
const groupKeyOf = (name: string) => name.trim().toLowerCase()

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
  const [now, setNow] = useState(() => currentInstant())
  const today = useMemo(() => universityClock(now), [now])
  /** Parity of the current (real) week. */
  const week = weekTypeFor(today.isoDate)
  const [role, setRole] = useState<Role>('student')
  const [activeDay, setActiveDay] = useState(today.weekdayIndex)
  /** Displayed week relative to the current one (0 = this week); shared by the day view and the calendar. */
  const [weekOffset, setWeekOffset] = useState(0)
  const weekStart = mondayOf(today.isoDate, weekOffset)
  const displayedWeek = weekTypeFor(weekStart)
  const [lessons, setLessons] = useState<Lesson[]>(demo ? demoLessons : [])
  const [notifications, setNotifications] = useState<AppNotification[]>(demo ? demoNotifications : [])
  /** Academic calendar in force. Starts on the built-in default (identical to the backend's), so nothing flashes before `GET /api/week` answers. */
  const [semesters, setSemesters] = useState<Semester[]>(() => activeSemesters())
  /** Non-working days already known, by date: `{ '2026-12-25': 'Crăciunul pe stil nou' }`. Filled week by week. */
  const [nonWorkingDays, setNonWorkingDays] = useState<Record<string, string>>({})
  /** Mondays whose calendar was already fetched; navigating back to a week does not ask again. */
  const fetchedWeeksRef = useRef(new Set<string>())
  const [roleEnabled, setRoleEnabled] = useState<Record<Role, boolean>>({ student: true, teacher: true })
  const [name, setName] = useState(initialName)
  const [syncState, setSyncState] = useState<SyncState>(demo ? 'demo' : 'loading')
  const [loadError, setLoadError] = useState('')
  /** The load failed with 401/403: retrying will not help, the Mini App has to be reopened. */
  const [sessionExpired, setSessionExpired] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** `role` is the schedule chosen when the editor opened; later role changes do not affect the lesson being edited. */
  const [editor, setEditor] = useState<{ lesson: Lesson | null, slot: { day: number, time: string } | null, role: Role } | null>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false)
  /** Group the catalog opens on (from a teacher lesson card); null opens the first group. */
  const [catalogGroup, setCatalogGroup] = useState<string | null>(null)
  /** Group names from the Teacher Catalog, offered as suggestions in the lesson editor. */
  const [catalogGroupNames, setCatalogGroupNames] = useState<string[]>([])
  /** Catalog groups may have changed (teacher lesson saved, catalog edited): re-fetch them before they are needed again. */
  const catalogGroupsStaleRef = useRef(true)
  const lastDateRef = useRef(today.isoDate)
  /** Profile PATCH requests are serialised: a second tap while one is pending is ignored. */
  const profileBusyRef = useRef(false)
  /** Same thing, but visible: the role controls are disabled while the change is being saved. */
  const [profileBusy, setProfileBusy] = useState(false)
  /** The user is looking at the current day: only then does the app follow the date change at midnight. */
  const onTodayRef = useRef(true)
  /** Latest committed week offset, readable after an `await` (the rendered value may already be stale). */
  const weekOffsetRef = useRef(weekOffset)
  const lastNotificationsFetchRef = useRef(0)

  const synced = syncState === 'ready'
  const success = (text: string) => setNotice({ kind: 'success', text })
  const failure = (text: string) => setNotice({ kind: 'error', text })

  /** A 401/403 on any request (not only at load) invalidates the session: the app stops pretending it can still save. */
  const noteSessionExpired = useCallback((error: unknown) => {
    if (!isSessionExpired(error)) return false
    const message = errorMessage(error, 'Sesiunea Telegram a expirat. Închide și redeschide Mini App-ul din bot.')
    setSessionExpired(true)
    setLoadError(message)
    setSyncState('error')
    setNotice({ kind: 'error', text: message })
    return true
  }, [])

  // Keep "now" fresh (lesson states depend on it), also right after the app becomes visible again; when the university date changes, jump to the new day.
  useEffect(() => {
    const tick = () => {
      const current = currentInstant()
      const clock = universityClock(current)
      // Follow the new day only if the user was still looking at today; a week chosen by hand stays where it is.
      if (clock.isoDate !== lastDateRef.current) {
        lastDateRef.current = clock.isoDate
        if (onTodayRef.current) { setActiveDay(clock.weekdayIndex); setWeekOffset(0) }
      }
      setNow(current)
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') tick() }
    const timer = window.setInterval(tick, CLOCK_TICK_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  useEffect(() => {
    if (demo) return
    let active = true
    loadAccount()
      .then(({ profile, lessons: savedLessons, notifications: savedNotifications }) => {
        if (!active) return
        setName((current) => profile.displayName || current)
        const roles = consistentRoles({ role: profile.role, enabled: { student: profile.studentEnabled, teacher: profile.teacherEnabled } })
        setRole(roles.role)
        setRoleEnabled(roles.enabled)
        setLessons(savedLessons)
        setNotifications(savedNotifications)
        lastNotificationsFetchRef.current = Date.now()
        setSyncState('ready')
        // The saved role is a disabled mode: store the enabled one (best effort — the UI already shows it).
        if (roles.role !== profile.role) updateRole(roles.role).catch(() => undefined)
      })
      .catch((error) => {
        if (!active) return
        setLoadError(errorMessage(error, 'Nu s-a putut încărca orarul.'))
        setSessionExpired(error instanceof ApiError && (error.status === 401 || error.status === 403))
        setSyncState('error')
      })
    return () => { active = false }
  }, [demo, reloadKey])

  /**
   * Academic calendar of the displayed week: the semesters (parity restarts at each one) and its days off.
   * A failure changes nothing — the app keeps computing on the default calendar — except for a 401/403,
   * which marks the session as expired like every other request.
   */
  useEffect(() => {
    if (!synced || fetchedWeeksRef.current.has(weekStart)) return
    let active = true
    loadWeekCalendar(weekStart)
      .then((calendar) => {
        if (!active) return
        fetchedWeeksRef.current.add(weekStart)
        // The module-level calendar drives parity everywhere; the state copy is what makes React re-render.
        setSemesters(installSemesters(calendar.semesters))
        setNonWorkingDays((current) => {
          const next = { ...current }
          for (const day of calendar.nonWorkingDays) next[day.date] = day.label
          return next
        })
      })
      .catch(noteSessionExpired)
    return () => { active = false }
  }, [synced, weekStart, noteSessionExpired])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const retryLoad = () => { fetchedWeeksRef.current.clear(); setSyncState('loading'); setLoadError(''); setReloadKey((value) => value + 1) }

  const dayLessons = lessons.filter((item) => item.role === role && item.weekday === activeDay)
  const displayedLessons = dayLessons.filter((item) => lessonMatchesWeek(item, displayedWeek)).sort(byStartTime)
  /** Lessons of this day that only happen in the other parity — hidden in the displayed week. */
  const otherParityCount = dayLessons.length - displayedLessons.length

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

  /** Lesson notifications belong to one schedule; general ones (no role) appear in both. */
  const belongsToRole = (item: AppNotification) => !item.role || item.role === role
  const roleNotifications = notifications.filter(belongsToRole)

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

  /** Returns the reason (also shown as a notice) when a change cannot be persisted right now, otherwise null. */
  const notWritableReason = () => {
    if (synced || syncState === 'demo') return null
    if (syncState === 'error' && sessionExpired) return loadError
    return syncState === 'loading' ? 'Orarul încă se încarcă. Încearcă în câteva secunde.' : 'Orarul nu este sincronizat. Apasă „Reîncearcă” mai întâi.'
  }
  const failureOf = (error: unknown, fallback: string): EditorFailure => ({
    message: errorMessage(error, fallback),
    fields: error instanceof ApiError ? error.fields.map(({ path, message }) => ({ path, message })) : [],
  })

  /** Saves through the API and stores the server's version (real id, normalised values). Never drops a failure silently. */
  const saveLesson = async (lesson: Lesson, isNew: boolean): Promise<EditorFailure | null> => {
    const blocked = notWritableReason()
    if (blocked) return { message: blocked, fields: [] }
    try {
      const saved = synced ? await (isNew ? saveLessonRemote(lesson) : updateLessonRemote(lesson)) : lesson
      // The backend adds the group of a teacher lesson to the catalog.
      if (saved.role === 'teacher' && saved.group) catalogGroupsStaleRef.current = true
      setLessons((items) => isNew ? [...items, saved] : items.map((item) => item.id === lesson.id ? saved : item))
      setEditor(null)
      // Show the day of the saved lesson; when its parity hides it in the displayed week, move to the next week, where it appears.
      setActiveDay(saved.weekday)
      let moved = ''
      if (!lessonMatchesWeek(saved, displayedWeek)) {
        // One value for both the new offset and the message, read after the save (not captured at render time).
        const nextOffset = weekOffsetRef.current + 1
        weekOffsetRef.current = nextOffset
        setWeekOffset(() => nextOffset)
        moved = ` Apare doar în săptămânile ${saved.weekType === 'even' ? 'pare' : 'impare'} — afișăm săptămâna ${formatWeekRange(mondayOf(today.isoDate, nextOffset))}.`
      }
      success((isNew ? (synced ? `Ora a fost salvată în orarul de ${roleLabels[saved.role]}.` : 'Ora a fost adăugată doar local (mod demonstrativ).') : 'Ora a fost modificată.') + moved)
      return null
    } catch (error) {
      noteSessionExpired(error)
      return failureOf(error, isNew ? 'Ora nu a putut fi salvată. Încearcă din nou.' : 'Modificarea nu a putut fi salvată.')
    }
  }

  const removeLesson = async (lesson: Lesson): Promise<EditorFailure | null> => {
    const blocked = notWritableReason()
    if (blocked) return { message: blocked, fields: [] }
    if (!(await confirmAction(`Ștergi „${lesson.title}”?`))) return null
    try {
      if (synced) await deleteLessonRemote(lesson.id)
      setLessons((items) => items.filter((item) => item.id !== lesson.id))
      setEditor(null)
      success('Ora a fost ștearsă.')
      return null
    } catch (error) {
      noteSessionExpired(error)
      return failureOf(error, 'Ora nu a putut fi ștearsă.')
    }
  }

  /** Best effort: without the catalog (e.g. no PostgreSQL) the editor still suggests the groups of the teacher's own lessons. */
  const refreshCatalogGroupNames = () => {
    if (!synced || !catalogGroupsStaleRef.current) return
    catalogGroupsStaleRef.current = false
    loadTeacherGroups()
      .then((items) => setCatalogGroupNames(items.map((item) => item.name)))
      .catch(() => { catalogGroupsStaleRef.current = true })
  }
  const openEditor = (state: NonNullable<typeof editor>) => {
    if (state.role === 'teacher') refreshCatalogGroupNames()
    setEditor(state)
  }
  const openNewLesson = (day = activeDay, time = '08:00') => openEditor({ lesson: null, slot: { day: Math.min(day, weekdayNames.length - 1), time }, role })
  const openLesson = (lesson: Lesson) => openEditor({ lesson, slot: null, role: lesson.role })
  const openGroupStudents = (group: string) => { setCatalogGroup(group); setGroupSettingsOpen(true) }
  const closeCatalog = () => { catalogGroupsStaleRef.current = true; setCatalogOpen(false); setGroupSettingsOpen(false); setCatalogGroup(null) }
  const groupSuggestions = useMemo(() => {
    const seen = new Set<string>()
    return [...catalogGroupNames, ...lessons.filter((item) => item.role === 'teacher').map((item) => item.group)]
      .map((name) => name.trim())
      .filter((name) => { const key = name.toLocaleLowerCase('ro'); if (!name || seen.has(key)) return false; seen.add(key); return true })
      .sort((a, b) => a.localeCompare(b, 'ro', { numeric: true }))
  }, [catalogGroupNames, lessons])

  /**
   * The catalog renamed a group; the backend renamed it in the Profesor lessons too, inside the same
   * transaction. Applying it locally (instead of re-fetching /api/lessons) keeps the change instant while
   * the catalog is still open, costs no request and cannot fail halfway — the match is the backend's own
   * `groupKey` rule. Returns how many lessons changed, so the catalog can say so.
   */
  const renameLessonGroup = useCallback((previousName: string, nextName: string) => {
    const key = groupKeyOf(previousName)
    const name = nextName.trim()
    if (!key || !name) return 0
    const affected = (item: Lesson) => item.role === 'teacher' && groupKeyOf(item.group) === key && item.group !== name
    const changed = lessons.filter(affected).length
    if (changed) setLessons((items) => items.map((item) => affected(item) ? { ...item, group: name } : item))
    return changed
  }, [lessons])

  /** Applies the fields returned by PATCH /api/me (the server is the source of truth). */
  const applyServerProfile = (profile: Partial<Pick<AccountProfile, 'role' | 'studentEnabled' | 'teacherEnabled'>>, fallback: RoleState) => {
    const roles = consistentRoles({
      role: profile.role ?? fallback.role,
      enabled: { student: profile.studentEnabled ?? fallback.enabled.student, teacher: profile.teacherEnabled ?? fallback.enabled.teacher },
    })
    setRole(roles.role)
    setRoleEnabled(roles.enabled)
  }

  /** Same guard as lesson saves; in demo mode changes stay local. Returns false (after showing why) when blocked. */
  const canChangeProfile = () => {
    const blocked = notWritableReason()
    if (blocked) { failure(blocked); return false }
    if (profileBusyRef.current) return false
    return true
  }

  const chooseRole = async (next: Role) => {
    if (next === role) return
    if (!canChangeProfile()) return
    if (!roleEnabled[next]) { failure(`Modul ${roleLabels[next]} este dezactivat. Activează-l din Profil.`); return }
    const previous: RoleState = { role, enabled: roleEnabled }
    setRole(next)
    if (!synced) return
    profileBusyRef.current = true
    setProfileBusy(true)
    try {
      applyServerProfile(await updateRole(next), { role: next, enabled: roleEnabled })
    } catch (error) {
      // 401 (expired session), 409 (mode disabled on the server), network…: undo the local change and say why.
      setRole(previous.role)
      setRoleEnabled(previous.enabled)
      if (!noteSessionExpired(error)) failure(errorMessage(error, 'Rolul nu a putut fi actualizat.'))
    } finally {
      profileBusyRef.current = false
      setProfileBusy(false)
    }
  }

  const toggleRoleEnabled = async (kind: Role) => {
    if (!canChangeProfile()) return
    const next = !roleEnabled[kind]
    const other = otherRole(kind)
    if (!next && !roleEnabled[other]) { failure('Cel puțin un mod trebuie să rămână activ.'); return }
    const previous: RoleState = { role, enabled: roleEnabled }
    const target: RoleState = { role: !next && role === kind ? other : role, enabled: { ...roleEnabled, [kind]: next } }
    setRole(target.role)
    setRoleEnabled(target.enabled)
    if (!synced) return
    profileBusyRef.current = true
    setProfileBusy(true)
    let roleChanged = false
    try {
      // Leave the mode first, so the server never has the active role disabled.
      if (target.role !== previous.role) { await updateRole(target.role); roleChanged = true }
      applyServerProfile(await updateProfileState(kind === 'student' ? { studentEnabled: next } : { teacherEnabled: next }), target)
    } catch (error) {
      if (roleChanged) updateRole(previous.role).catch(() => undefined)
      setRole(previous.role)
      setRoleEnabled(previous.enabled)
      if (!noteSessionExpired(error)) failure(errorMessage(error, 'Starea nu a putut fi actualizată.'))
    } finally {
      profileBusyRef.current = false
      setProfileBusy(false)
    }
  }

  /** Re-fetches notifications created on the server (reminders, "Orar actualizat") without losing local read marks. */
  const refreshNotifications = useCallback(async () => {
    if (!synced) return null
    lastNotificationsFetchRef.current = Date.now()
    try {
      const fresh = await loadNotifications()
      setNotifications((local) => mergeNotifications(local, fresh))
      return fresh
    } catch {
      return null // Keep what is already shown; a failed background refresh is not worth an error notice.
    }
  }, [synced])

  useEffect(() => {
    if (!synced) return
    let timer = 0
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (Date.now() - lastNotificationsFetchRef.current >= NOTIFICATIONS_REFRESH_MIN_MS) void refreshNotifications()
      }, VISIBILITY_DEBOUNCE_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.clearTimeout(timer) }
  }, [synced, refreshNotifications])

  const openNotifications = async () => {
    setNotificationsOpen(true)
    const openedFor = role
    const current = synced ? (await refreshNotifications()) ?? notifications : notifications
    const forRole = (item: AppNotification) => !item.role || item.role === openedFor
    if (!current.some((item) => forRole(item) && !item.readAt)) return
    try {
      if (synced) await markNotificationsRead(openedFor)
      else if (syncState !== 'demo') return
      const readAt = new Date().toISOString()
      setNotifications((items) => items.map((item) => forRole(item) ? { ...item, readAt: item.readAt ?? readAt } : item))
    } catch (error) {
      if (!noteSessionExpired(error)) failure(errorMessage(error, 'Notificările nu au putut fi marcate ca citite.'))
    }
  }

  const shiftWeek = (delta: number) => setWeekOffset((value) => value + delta)
  const resetWeek = () => { setWeekOffset(0); setActiveDay(today.weekdayIndex) }
  const selectDay = (index: number) => {
    // On Sunday the next Monday is tomorrow: show it instead of the Monday that has passed.
    if (today.weekdayIndex === weekdayNames.length - 1 && weekOffset === 0 && index === 0) setWeekOffset(1)
    setActiveDay(index)
  }

  const dateForDay = (dayIndex: number) => addDays(weekStart, dayIndex)
  const unreadCount = roleNotifications.filter((item) => !item.readAt).length
  const isToday = weekOffset === 0 && activeDay === today.weekdayIndex
  useEffect(() => { onTodayRef.current = isToday }, [isToday])
  useEffect(() => { weekOffsetRef.current = weekOffset }, [weekOffset])
  const displayedDate = dateForDay(activeDay)
  /**
   * A public holiday, a day added by the university or a date outside every semester. Product decision:
   * the lessons stay visible (a day off is often recovered), only the reminders go quiet.
   */
  const dayOff = useMemo(() => {
    const label = nonWorkingDays[displayedDate]
    if (label) return `Zi liberă · ${label}`
    return isStudyDay(displayedDate, semesters) ? '' : 'Vacanță'
  }, [displayedDate, nonWorkingDays, semesters])
  /** Start of the semester the current parity is counted from (the last one already begun). */
  const semesterStart = semesterAnchorOf(today.isoDate, semesters).start
  const timings = displayedLessons.map((lesson) => lessonTiming(lesson, displayedDate, today))
  const doneForToday = isToday && timings.length > 0 && timings.every((timing) => timing.state === 'past')

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
        <p>Calculat automat pentru data curentă, de la începutul semestrului ({formatDayMonth(semesterStart)} {semesterStart.slice(0, 4)}).</p>
      </div>
      <div className="next-class" aria-label="Următoarea oră">
        <span>URMĂTOAREA ORĂ</span>
        {nextLesson ? <><b>{nextLesson.lesson.startTime}</b><small>{nextLesson.lesson.title}</small><em>{nextLesson.label}</em></> : <><b>—</b><small>Nu ai ore planificate</small></>}
      </div>
    </section>

    <section className="role-card" aria-label="Rol activ">
      <div><span className="role-icon" aria-hidden="true">{role === 'student' ? '🎓' : '🧑‍🏫'}</span><div><strong>{roleLabels[role]}</strong><small>{role === 'student' ? 'Vezi orele grupei tale' : 'Gestionează orele predate'}</small></div></div>
      <div className="role-switch" role="group" aria-label="Alege rolul">
        {(['student', 'teacher'] as const).map((kind) => <button type="button" key={kind} className={role === kind ? 'selected' : ''} aria-pressed={role === kind} disabled={profileBusy} aria-busy={profileBusy}
          onClick={() => chooseRole(kind)}>{roleLabels[kind]}</button>)}
      </div>
    </section>

    <WeekNav start={weekStart} offset={weekOffset} onShift={shiftWeek} onReset={resetWeek} resetVisible={!isToday} />
    <nav className="day-tabs" aria-label="Alege ziua">
      {weekdayNames.map((day, index) => {
        const current = weekOffset === 0 && index === today.weekdayIndex
        return <button type="button" key={day} className={[activeDay === index ? 'active' : '', current ? 'today' : ''].filter(Boolean).join(' ')} aria-pressed={activeDay === index} aria-current={current ? 'date' : undefined}
          aria-label={`${day} ${formatDayMonth(dateForDay(index))}${current ? ', azi' : ''}`} onClick={() => selectDay(index)}><span>{day.slice(0, 2)}</span><b>{dayOfMonth(dateForDay(index))}</b></button>
      })}
    </nav>

    <section className="schedule" aria-labelledby="schedule-heading">
      <div className="section-heading">
        <div><p>{weekdayNames[activeDay]}, {formatDayMonth(dateForDay(activeDay))} · săpt. {weekTypeLabels[displayedWeek]}</p><h2 id="schedule-heading">Orele tale</h2></div>
        <button type="button" className="add-button" onClick={() => openNewLesson()} aria-label="Adaugă o oră">+</button>
      </div>
      {dayOff && <p className="day-off" role="note"><b>{dayOff}</b><span>Orele rămân afișate, dar în această zi nu se trimit memento-uri.</span></p>}
      {syncState === 'loading' && <p className="sync" role="status">Se conectează la orarul tău…</p>}
      {notice && <p className={notice.kind === 'success' ? 'success' : 'error-notice'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.kind === 'success' ? '✓ ' : '⚠ '}{notice.text}</p>}
      {syncState === 'error' ? <div className="empty" role="alert">
        <span aria-hidden="true">⚠️</span><h3>Orarul nu a putut fi încărcat</h3><p>{loadError}</p><button type="button" onClick={retryLoad}>Reîncearcă</button>
      </div> : syncState === 'loading' ? null : displayedLessons.length ? <div className="timeline">
        {displayedLessons.map((lesson, index) => <LessonCard key={lesson.id} lesson={lesson} role={role} timing={timings[index]} muted={Boolean(dayOff)} onEdit={() => openLesson(lesson)} onOpenGroup={role === 'teacher' ? openGroupStudents : undefined} />)}
        {doneForToday && <p className="day-done">Gata pe azi <span aria-hidden="true">🎉</span>{nextLesson ? <> Următoarea oră: <b>{nextLesson.lesson.title}</b> · {nextLesson.label} {nextLesson.lesson.startTime}</> : ' Nu mai ai alte ore planificate.'}</p>}
      </div> : <div className="empty free-day">
        <span aria-hidden="true">☀️</span><h3>{isToday ? 'Ești liber azi' : 'Zi liberă'}</h3><p>Nu ai nicio pereche în această zi. Bucură-te de timp liber!</p><button type="button" onClick={() => openNewLesson()}>Adaugă o activitate</button>
      </div>}
      {syncState !== 'loading' && syncState !== 'error' && otherParityCount > 0 && <button type="button" className="week-hint" onClick={() => shiftWeek(1)}>
        {otherParityCount === 1 ? 'O oră' : `${otherParityCount} ore`} în această zi doar în săptămâna {weekTypeLabels[displayedWeek === 'even' ? 'odd' : 'even']} <span aria-hidden="true">›</span>
      </button>}
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

    {calendarOpen && <CalendarPanel lessons={lessons} role={role} clock={today} weekStart={weekStart} weekOffset={weekOffset} onShiftWeek={shiftWeek} onResetWeek={() => setWeekOffset(0)}
      onClose={() => setCalendarOpen(false)} onAdd={openNewLesson} onEdit={(lesson) => { setCalendarOpen(false); openLesson(lesson) }} />}
    {editor && <LessonEditor key={editor.lesson?.id ?? 'new'} role={editor.role} existing={editor.lesson} slot={editor.slot} onClose={() => setEditor(null)}
      groupSuggestions={editor.role === 'teacher' ? groupSuggestions : undefined} onSave={(lesson) => saveLesson(lesson, !editor.lesson)} onDelete={editor.lesson ? () => removeLesson(editor.lesson as Lesson) : undefined} />}
    {notificationsOpen && <NotificationPanel items={roleNotifications} error={notice?.kind === 'error' ? notice.text : ''} onClose={() => setNotificationsOpen(false)} />}
    {profileOpen && <ProfilePanel name={name} role={role} week={week} enabled={roleEnabled} synced={synced} error={notice?.kind === 'error' ? notice.text : ''} busy={profileBusy} onClose={() => setProfileOpen(false)}
      onSwitchRole={() => chooseRole(otherRole(role))} onToggle={toggleRoleEnabled} onOpenGroupSettings={() => { setProfileOpen(false); setGroupSettingsOpen(true) }} />}
    {groupSettingsOpen && <TeacherCatalog mode="settings" available={synced} initialGroupName={catalogGroup ?? undefined} onClose={closeCatalog} onSessionExpired={noteSessionExpired} onGroupRenamed={renameLessonGroup} />}
    {catalogOpen && <TeacherCatalog mode="records" available={synced} onClose={closeCatalog} onSessionExpired={noteSessionExpired} onGroupRenamed={renameLessonGroup} />}
  </main>
}
