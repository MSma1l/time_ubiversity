import { describe, expect, it } from "vitest";
import { openDatabase, pruneDatabase } from "./db.js";
import { sendDueReminders } from "./reminders.js";
import { TelegramApiError } from "./telegram.js";

const silent = { error: () => undefined };
// Monday 14 Sept 2026 (odd week), 07:45 in Chisinau (UTC+3).
const AT_0745 = new Date("2026-09-14T04:45:00Z");

function setup() {
  const db = openDatabase(":memory:");
  const insert = db.prepare("INSERT INTO lessons (owner_id, role, title, room, weekday, start_time, end_time, week_kind, reminder_minutes) VALUES (?,?,?,?,?,?,?,?,?)");
  return { db, insert };
}

describe("sendDueReminders", () => {
  it("sends each due reminder exactly once, respecting parity", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", "3-101", 1, "08:00", "09:30", "odd", 15);
    insert.run(1, "student", "Chimie", null, 1, "08:00", "09:30", "even", 15);
    insert.run(2, "student", "Istorie", null, 1, "09:00", "10:30", "every", 15);
    const sent: Array<[number, string]> = [];
    const send = async (chatId: number, text: string) => { sent.push([chatId, text]); };
    expect(await sendDueReminders(db, send, AT_0745, silent)).toBe(1);
    // A second tick in the same or next minute (or a restarted process) must not resend.
    expect(await sendDueReminders(db, send, AT_0745, silent)).toBe(0);
    expect(await sendDueReminders(db, send, new Date(AT_0745.getTime() + 60_000), silent)).toBe(0);
    expect(sent).toEqual([[1, "🔔 În 15 min: Fizică\n08:00–09:30 · Sala 3-101"]]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='reminder'").get()).toEqual({ c: 1 });
  });

  it("retries transient failures but not blocked users, and skips disabled role modes", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "A", null, 1, "08:00", "09:00", "every", 15);
    insert.run(2, "student", "B", null, 1, "08:00", "09:00", "every", 15);
    insert.run(3, "teacher", "C", null, 1, "08:00", "09:00", "every", 15);
    db.prepare("INSERT INTO profiles (telegram_id, display_name, teacher_enabled) VALUES (3, 'P', 0)").run();
    let attempts = 0;
    const send = async (chatId: number) => {
      attempts += 1;
      if (chatId === 1 && attempts === 1) throw new TelegramApiError("timeout", 502);
      if (chatId === 2) throw new TelegramApiError("blocked", 403);
    };
    expect(await sendDueReminders(db, send, AT_0745, silent)).toBe(0);
    expect(await sendDueReminders(db, send, new Date(AT_0745.getTime() + 60_000), silent)).toBe(1);
    expect(attempts).toBe(3);
  });

  it("catches up a start-time reminder (reminderMinutes=0) when the exact minute was missed, once", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 0);
    const sent: string[] = [];
    const send = async (_chatId: number, text: string) => { sent.push(text); };
    const at = (minutesAfter0745: number) => new Date(AT_0745.getTime() + minutesAfter0745 * 60_000);
    // Cron missed 08:00 and 08:01; it wakes at 08:02.
    expect(await sendDueReminders(db, send, at(14), silent)).toBe(0);
    expect(await sendDueReminders(db, send, at(17), silent)).toBe(1);
    expect(await sendDueReminders(db, send, at(18), silent)).toBe(0);
    expect(await sendDueReminders(db, send, at(20), silent)).toBe(0);
    expect(sent).toEqual(["🔔 A început acum 2 min: Fizică\n08:00–09:30"]);
  });

  it("does not send a start-time reminder more than the grace window after the lesson started", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 0);
    const sent: string[] = [];
    expect(await sendDueReminders(db, async (_c, text) => { sent.push(text); }, new Date(AT_0745.getTime() + 21 * 60_000), silent)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("prunes old reminder bookkeeping", () => {
    const { db } = setup();
    db.prepare("INSERT INTO delivered_reminders VALUES (1, '2026-08-01-08:00')").run();
    expect(pruneDatabase(db, "2026-09-14").reminders).toBe(1);
  });
});
