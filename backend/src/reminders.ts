import { addNotification, LESSON_COLUMNS, toLesson, type Lesson, type SqliteDatabase } from "./db.js";
import { minutesLabel } from "./labels.js";
import { chisinauClock, dueReminderOccurrence } from "./schedule.js";
import { TelegramApiError } from "./telegram.js";

export type ReminderSender = (chatId: number, text: string) => Promise<void>;

function lessonDetails(lesson: Lesson) {
  return `${lesson.startTime}–${lesson.endTime}${lesson.room ? ` · Sala ${lesson.room}` : ""}${lesson.groupName ? ` · Grupa ${lesson.groupName}` : ""}`;
}

/**
 * Sends reminders that became due. Each occurrence is reserved in `delivered_reminders`
 * *before* sending, so overlapping ticks, restarts or a second instance on the same
 * database can never deliver the same reminder twice. Profiles with `reminders_enabled=0`
 * (bot /notificari off) and disabled Student/Profesor modes receive nothing.
 */
export async function sendDueReminders(db: SqliteDatabase, send: ReminderSender, now = new Date(), log: Pick<Console, "error"> = console) {
  const clock = chisinauClock(now);
  const tomorrow = (clock.weekday % 7) + 1;
  // Yesterday is included so a late-evening lesson's grace window can run past midnight.
  const yesterday = ((clock.weekday + 5) % 7) + 1;
  const rows = db.prepare(`SELECT ${LESSON_COLUMNS.split(", ").map((column) => `l.${column}`).join(", ")} FROM lessons l LEFT JOIN profiles p ON p.telegram_id=l.owner_id
    WHERE l.weekday IN (?, ?, ?) AND l.notifications_enabled=1 AND COALESCE(p.reminders_enabled,1)=1
      AND NOT (l.role='student' AND COALESCE(p.student_enabled,1)=0) AND NOT (l.role='teacher' AND COALESCE(p.teacher_enabled,1)=0)`)
    .all(yesterday, clock.weekday, tomorrow) as Parameters<typeof toLesson>[0][];
  const reserve = db.prepare("INSERT OR IGNORE INTO delivered_reminders (lesson_id, occurrence_key) VALUES (?,?)");
  const release = db.prepare("DELETE FROM delivered_reminders WHERE lesson_id=? AND occurrence_key=?");
  let sent = 0;
  for (const lesson of rows.map(toLesson)) {
    const due = dueReminderOccurrence(lesson, clock);
    if (!due) continue;
    const key = `${due.date}-${lesson.startTime}`;
    if (!reserve.run(lesson.id, key).changes) continue;
    const heading = due.minutesUntilStart > 0 ? `În ${minutesLabel(due.minutesUntilStart)}: ${lesson.title}`
      : due.minutesUntilStart < 0 ? `A început acum ${minutesLabel(-due.minutesUntilStart)}: ${lesson.title}` : `Acum începe: ${lesson.title}`;
    try {
      await send(lesson.ownerId, `🔔 ${heading}\n${lessonDetails(lesson)}`);
    } catch (error) {
      // 400/403: chat not found or the user blocked the bot. Retrying would not help.
      const permanent = error instanceof TelegramApiError && (error.status === 400 || error.status === 403);
      if (!permanent) release.run(lesson.id, key);
      log.error(`Reminder for lesson ${lesson.id} failed${permanent ? "" : " (will retry)"}:`, error instanceof Error ? error.message : error);
      continue;
    }
    sent += 1;
    try {
      addNotification(db, lesson.ownerId, "reminder", due.minutesUntilStart > 0 ? `În ${minutesLabel(due.minutesUntilStart)} începe ${lesson.title}`
        : due.minutesUntilStart < 0 ? `${lesson.title} a început acum ${minutesLabel(-due.minutesUntilStart)}` : `Acum începe ${lesson.title}`, lessonDetails(lesson), lesson.role);
    } catch (error) { log.error("Could not store reminder notification:", error); }
  }
  return sent;
}
