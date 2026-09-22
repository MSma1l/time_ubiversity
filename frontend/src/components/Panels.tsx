import { useState } from 'react'
import { useDialog } from '../dialogs'
import { addDays, formatServerDate, formatWeekRange, lessonMatchesWeek, lessonTiming, teachingDays, timeToMinutes, weekdayNames, weekTypeFor, weekTypeLabels, type UniversityClock } from '../schedule'
import { initialOf, roleLabels, timingText } from '../labels'
import { CheckIcon } from './LessonCard'
import type { AppNotification, Lesson, Role, WeekType } from '../types'

/** `error` is shown here because the page notice stays behind this panel. */
export function NotificationPanel({ items, error, onClose }: { items: AppNotification[], error?: string, onClose(): void }) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notifications-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>CENTRU NOTIFICĂRI</p><h2 id="notifications-title">Totul la zi</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      {error && <p className="error-notice profile-error" role="alert">⚠ {error}</p>}
      {items.length ? <div className="notification-list">
        {items.map((item) => <article className={`notification-item ${item.kind}`} key={item.id}>
          <span aria-hidden="true">{item.kind === 'reminder' ? '🔔' : '✓'}</span>
          <div><h3>{item.title}</h3><p>{item.body}</p><time dateTime={item.createdAt}>{formatServerDate(item.createdAt)}</time></div>
        </article>)}
      </div> : <div className="empty"><span aria-hidden="true">🔕</span><h3>Încă nu ai notificări</h3><p>Memento-urile și mesajele sistemului vor apărea aici.</p></div>}
    </section>
  </div>
}

const timeSlots = ['08:00', '09:45', '11:30', '13:30', '15:15', '17:00', '18:45']
const slotMinutes = timeSlots.map(timeToMinutes)
/** A lesson belongs to the last slot that starts at or before it, so custom start times still appear in the grid. */
const slotIndexFor = (time: string) => {
  const minutes = timeToMinutes(time)
  let index = 0
  slotMinutes.forEach((start, i) => { if (start <= minutes) index = i })
  return index
}
const shortWeek: Record<Lesson['weekType'], string> = { both: 'ambele', even: 'pară', odd: 'impară' }

type WeekNavProps = { start: string, offset: number, onShift(delta: number): void, onReset(): void, resetVisible?: boolean }

/** ‹ week range + parity › with a reset to the current week. Compact enough for a 390px screen. */
export function WeekNav({ start, offset, onShift, onReset, resetVisible = offset !== 0 }: WeekNavProps) {
  const parity = weekTypeFor(start)
  const relative = offset === 0 ? 'Săptămâna curentă' : offset === 1 ? 'Săptămâna viitoare' : offset === -1 ? 'Săptămâna trecută' : offset > 0 ? `Peste ${offset} săptămâni` : `Acum ${-offset} săptămâni`
  return <div className="week-nav" role="group" aria-label="Alege săptămâna">
    <button type="button" className="week-nav-arrow" onClick={() => onShift(-1)} aria-label="Săptămâna anterioară">‹</button>
    <div className="week-nav-label" aria-live="polite">
      <b>{formatWeekRange(start)}</b>
      <small><span className={`week-chip ${parity}`}>{weekTypeLabels[parity]}</span>{relative}</small>
    </div>
    {resetVisible && <button type="button" className="week-nav-reset" onClick={onReset} aria-label="Înapoi la ziua de azi">Azi</button>}
    <button type="button" className="week-nav-arrow" onClick={() => onShift(1)} aria-label="Săptămâna următoare">›</button>
  </div>
}

type CalendarProps = {
  lessons: Lesson[], role: Role, weekStart: string, weekOffset: number,
  /** University clock: lessons of the displayed week are marked past / current. */
  clock: UniversityClock,
  onShiftWeek(delta: number): void, onResetWeek(): void, onClose(): void, onAdd(day: number, time: string): void, onEdit(lesson: Lesson): void,
}

export function CalendarPanel({ lessons, role, clock, weekStart, weekOffset, onShiftWeek, onResetWeek, onClose, onAdd, onEdit }: CalendarProps) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  /** Off: only the displayed week's lessons. On: every lesson of the role; the other parity is dimmed but still editable. */
  const [showAll, setShowAll] = useState(false)
  const week = weekTypeFor(weekStart)
  const roleLessons = lessons.filter((lesson) => lesson.role === role)
  const visible = showAll ? roleLessons : roleLessons.filter((lesson) => lessonMatchesWeek(lesson, week))
  const hiddenCount = roleLessons.length - roleLessons.filter((lesson) => lessonMatchesWeek(lesson, week)).length
  // Sunday gets a column only when it actually has visible lessons.
  const hasSunday = visible.some((lesson) => lesson.weekday === weekdayNames.length - 1)
  const days = hasSunday ? weekdayNames : teachingDays
  const cells = new Map<string, Lesson[]>()
  // This week's lessons first, then by start time.
  const order = (a: Lesson, b: Lesson) => Number(!lessonMatchesWeek(a, week)) - Number(!lessonMatchesWeek(b, week)) || a.startTime.localeCompare(b.startTime)
  for (const lesson of visible) {
    if (lesson.weekday < 0 || lesson.weekday >= days.length) continue
    const key = `${lesson.weekday}-${slotIndexFor(lesson.startTime)}`
    cells.set(key, [...(cells.get(key) ?? []), lesson].sort(order))
  }
  const roleName = roleLabels[role]

  return <div className="modal-backdrop calendar-backdrop" role="presentation">
    <section ref={dialogRef} className="calendar-panel" role="dialog" aria-modal="true" aria-labelledby="calendar-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>ORAR {roleName.toUpperCase()} · SĂPTĂMÂNA {weekTypeLabels[week].toUpperCase()}</p><h2 id="calendar-title">Calendarul orelor</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <div className="calendar-toolbar"><WeekNav start={weekStart} offset={weekOffset} onShift={onShiftWeek} onReset={onResetWeek} /></div>
      <div className="calendar-hint-row">
        <p className="calendar-hint">Orarul de {roleName}. {showAll ? `Orele doar din săptămâna ${weekTypeLabels[week === 'even' ? 'odd' : 'even']} sunt estompate și pot fi editate.` : 'Doar orele din această săptămână.'}</p>
        <button type="button" className={`calendar-toggle ${showAll ? 'on' : ''}`} aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
          Toate orele{!showAll && hiddenCount > 0 ? ` (+${hiddenCount})` : ''}
        </button>
      </div>
      <div className={`calendar-grid ${hasSunday ? 'with-sunday' : ''}`}>
        <div className="calendar-head time-head">Ora</div>
        {days.map((day) => <div className="calendar-head" key={day}>{day.slice(0, 2)}</div>)}
        {timeSlots.flatMap((time, slot) => [
          <div className="time-label" key={`${time}-label`}>{time}</div>,
          ...days.map((dayName, day) => {
            const items = cells.get(`${day}-${slot}`) ?? []
            if (!items.length) return <button type="button" className="calendar-cell" key={`${day}-${time}`} onClick={() => onAdd(day, time)} aria-label={`Adaugă o oră ${dayName} la ${time}`}><span aria-hidden="true">+</span></button>
            return <div className="calendar-cell occupied" key={`${day}-${time}`}>
              {items.map((item) => {
                const inWeek = lessonMatchesWeek(item, week)
                // Only lessons that take place in the displayed week have a time state.
                const timing = inWeek ? lessonTiming(item, addDays(weekStart, day), clock) : undefined
                const state = timing?.state === 'past' || timing?.state === 'current' ? timing.state : ''
                const spoken = state ? `, ${timingText(timing)?.spoken}` : ''
                return <button type="button" key={item.id} className={['calendar-lesson', inWeek ? '' : 'other-week', state].filter(Boolean).join(' ')} onClick={() => onEdit(item)}
                  aria-label={`Editează ${item.title}, ${dayName} ${item.startTime}, ${shortWeek[item.weekType]}${inWeek ? '' : ' (nu în această săptămână)'}${spoken}`}>
                  {state === 'past' && <CheckIcon />}{state === 'current' && <i className="live-dot" aria-hidden="true" />}
                  <b>{item.title}</b><small>{item.startTime !== time ? `${item.startTime} · ` : ''}{item.room}</small><em>{shortWeek[item.weekType]}</em>
                </button>
              })}
            </div>
          }),
        ])}
      </div>
    </section>
  </div>
}

type ProfileProps = {
  name: string, role: Role, week: WeekType, enabled: Record<Role, boolean>, synced: boolean,
  /** Why the last role/mode change failed; shown here because the page notice is hidden behind the panel. */
  error?: string,
  /** A role/mode change is still being saved: the controls stay disabled so a second tap is not lost silently. */
  busy?: boolean,
  onClose(): void, onSwitchRole(): void, onToggle(role: Role): void, onOpenGroupSettings(): void,
}

export function ProfilePanel({ name, role, week, enabled, synced, error, busy = false, onClose, onSwitchRole, onToggle, onOpenGroupSettings }: ProfileProps) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="notification-panel profile-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>ORAR UNIVER · TELEGRAM</p><h2 id="profile-title">Profilul meu</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <div className="profile-hero"><span aria-hidden="true">{initialOf(name)}</span><div><h3>{name || 'Utilizator'}</h3><p>{synced ? 'Conectat automat prin Telegram' : 'Neconectat — datele nu se sincronizează'}</p></div></div>
      {error && <p className="error-notice profile-error" role="alert">⚠ {error}</p>}
      <div className="profile-setting"><div><strong>Rol activ</strong><p>{roleLabels[role]}</p></div><button type="button" onClick={onSwitchRole} disabled={busy} aria-busy={busy}>{busy ? 'Se salvează…' : 'Schimbă rolul'}</button></div>
      {(['student', 'teacher'] as const).map((kind) => <div className="profile-setting" key={kind}>
        <div><strong>Mod {roleLabels[kind]}</strong><p>{enabled[kind] ? (kind === 'student' ? 'Activ — vezi orele tale' : 'Activ — gestionezi orele') : 'Dezactivat'}</p></div>
        <button type="button" className={`status-toggle ${enabled[kind] ? 'on' : ''}`} onClick={() => onToggle(kind)} aria-pressed={enabled[kind]} disabled={busy} aria-busy={busy} aria-label={`Mod ${roleLabels[kind]}`}><i /></button>
      </div>)}
      {role === 'teacher' && <button type="button" className="profile-setting group-settings-link" onClick={onOpenGroupSettings}><span className="setting-icon" aria-hidden="true">⚙</span><div><strong>Setări grupe</strong><p>Grupe, studenți, prezență și note</p></div><span aria-hidden="true">›</span></button>}
      <div className="profile-setting"><div><strong>Paritatea săptămânii</strong><p>Calcul automat: săptămâna aceasta este {weekTypeLabels[week]}</p></div><span className="auto-dot">AUTO</span></div>
      <p className="profile-note">Profilul este al contului Telegram cu care ai deschis Mini App-ul. Când redeschizi aplicația, sesiunea se validează automat pe server, iar datele tale rămân separate de ale altor utilizatori.</p>
    </section>
  </div>
}
