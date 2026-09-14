import { useDialog } from '../dialogs'
import { formatServerDate, lessonMatchesWeek, teachingDays, timeToMinutes, weekdayNames } from '../schedule'
import { initialOf, roleLabels } from '../labels'
import type { AppNotification, Lesson, Role, WeekType } from '../types'

export function NotificationPanel({ items, onClose }: { items: AppNotification[], onClose(): void }) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="notification-panel" role="dialog" aria-modal="true" aria-labelledby="notifications-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>CENTRU NOTIFICĂRI</p><h2 id="notifications-title">Totul la zi</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
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

type CalendarProps = { lessons: Lesson[], role: Role, week: WeekType, onClose(): void, onAdd(day: number, time: string): void, onEdit(lesson: Lesson): void }

export function CalendarPanel({ lessons, role, week, onClose, onAdd, onEdit }: CalendarProps) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  const visible = lessons.filter((lesson) => lesson.role === role && lessonMatchesWeek(lesson, week))
  // Sunday gets a column only when it actually has lessons this week.
  const hasSunday = visible.some((lesson) => lesson.weekday === weekdayNames.length - 1)
  const days = hasSunday ? weekdayNames : teachingDays
  const cells = new Map<string, Lesson[]>()
  for (const lesson of visible) {
    if (lesson.weekday < 0 || lesson.weekday >= days.length) continue
    const key = `${lesson.weekday}-${slotIndexFor(lesson.startTime)}`
    cells.set(key, [...(cells.get(key) ?? []), lesson].sort((a, b) => a.startTime.localeCompare(b.startTime)))
  }
  const roleName = roleLabels[role]

  return <div className="modal-backdrop calendar-backdrop" role="presentation">
    <section ref={dialogRef} className="calendar-panel" role="dialog" aria-modal="true" aria-labelledby="calendar-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>ORAR {roleName.toUpperCase()} · SĂPTĂMÂNA {week === 'even' ? 'PARĂ' : 'IMPARĂ'}</p><h2 id="calendar-title">Calendarul orelor</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <p className="calendar-hint">Acesta este orarul de {roleName}. Adaugi și editezi doar orele acestui rol.</p>
      <div className={`calendar-grid ${hasSunday ? 'with-sunday' : ''}`}>
        <div className="calendar-head time-head">Ora</div>
        {days.map((day) => <div className="calendar-head" key={day}>{day.slice(0, 2)}</div>)}
        {timeSlots.flatMap((time, slot) => [
          <div className="time-label" key={`${time}-label`}>{time}</div>,
          ...days.map((dayName, day) => {
            const items = cells.get(`${day}-${slot}`) ?? []
            const item = items[0]
            return <button type="button" className={`calendar-cell ${item ? 'occupied' : ''}`} key={`${day}-${time}`} onClick={() => item ? onEdit(item) : onAdd(day, time)}
              aria-label={item ? `Editează ${item.title}, ${dayName} ${item.startTime}` : `Adaugă o oră ${dayName} la ${time}`}>
              {item ? <><b>{item.title}</b><small>{item.startTime !== time ? `${item.startTime} · ` : ''}{item.room}</small><em>{shortWeek[item.weekType]}{items.length > 1 ? ` +${items.length - 1}` : ''}</em></> : <span aria-hidden="true">+</span>}
            </button>
          }),
        ])}
      </div>
    </section>
  </div>
}

type ProfileProps = {
  name: string, role: Role, week: WeekType, enabled: Record<Role, boolean>, synced: boolean,
  onClose(): void, onSwitchRole(): void, onToggle(role: Role): void, onOpenGroupSettings(): void,
}

export function ProfilePanel({ name, role, week, enabled, synced, onClose, onSwitchRole, onToggle, onOpenGroupSettings }: ProfileProps) {
  const dialogRef = useDialog<HTMLElement>(onClose)
  return <div className="modal-backdrop" role="presentation">
    <section ref={dialogRef} className="notification-panel profile-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title" tabIndex={-1}>
      <div className="modal-heading">
        <div><p>CONTUL MEU · TELEGRAM</p><h2 id="profile-title">Profil UTM</h2></div>
        <button type="button" onClick={onClose} aria-label="Închide">×</button>
      </div>
      <div className="profile-hero"><span aria-hidden="true">{initialOf(name)}</span><div><h3>{name || 'Utilizator'}</h3><p>{synced ? 'Conectat automat prin Telegram' : 'Neconectat — datele nu se sincronizează'}</p></div></div>
      <div className="profile-setting"><div><strong>Rol activ</strong><p>{roleLabels[role]}</p></div><button type="button" onClick={onSwitchRole}>Schimbă rolul</button></div>
      {(['student', 'teacher'] as const).map((kind) => <div className="profile-setting" key={kind}>
        <div><strong>Mod {roleLabels[kind]}</strong><p>{enabled[kind] ? (kind === 'student' ? 'Activ — vezi orele tale' : 'Activ — gestionezi orele') : 'Dezactivat'}</p></div>
        <button type="button" className={`status-toggle ${enabled[kind] ? 'on' : ''}`} onClick={() => onToggle(kind)} aria-pressed={enabled[kind]} aria-label={`Mod ${roleLabels[kind]}`}><i /></button>
      </div>)}
      {role === 'teacher' && <button type="button" className="profile-setting group-settings-link" onClick={onOpenGroupSettings}><span className="setting-icon" aria-hidden="true">⚙</span><div><strong>Setări grupe</strong><p>Grupe, studenți, prezență și note</p></div><span aria-hidden="true">›</span></button>}
      <div className="profile-setting"><div><strong>Paritatea săptămânii</strong><p>Calcul automat: {week === 'even' ? 'pară' : 'impară'}</p></div><span className="auto-dot">AUTO</span></div>
      <p className="profile-note">Profilul este al contului Telegram cu care ai deschis Mini App-ul. Când redeschizi aplicația, sesiunea se validează automat pe server, iar datele tale rămân separate de ale altor utilizatori.</p>
    </section>
  </div>
}
