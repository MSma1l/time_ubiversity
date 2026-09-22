import { describe, expect, it } from "vitest";
import { openDatabase, pruneDatabase, seedLegalHolidays, setNonWorkingDay } from "./db.js";
import { minutesLabel } from "./labels.js";
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
    expect(sent).toEqual([[1, "🔔 În 15 minute: Fizică\n08:00–09:30 · Sala 3-101"]]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='reminder'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT role FROM notifications WHERE kind='reminder'").get()).toEqual({ role: "student" });
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
    expect(sent).toEqual(["🔔 A început acum 2 minute: Fizică\n08:00–09:30"]);
  });

  it("does not send a start-time reminder more than the grace window after the lesson started", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 0);
    const sent: string[] = [];
    expect(await sendDueReminders(db, async (_c, text) => { sent.push(text); }, new Date(AT_0745.getTime() + 21 * 60_000), silent)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("uses Romanian grammar for minutes in the reminder and the stored notification", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:05", "09:30", "every", 20);
    const sent: string[] = [];
    expect(await sendDueReminders(db, async (_c, text) => { sent.push(text); }, AT_0745, silent)).toBe(1);
    expect(sent).toEqual(["🔔 În 20 de minute: Fizică\n08:05–09:30"]);
    expect(db.prepare("SELECT title FROM notifications WHERE kind='reminder'").get()).toEqual({ title: "În 20 de minute începe Fizică" });
  });

  it("skips profiles with reminders turned off without touching lesson settings", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "A", null, 1, "08:00", "09:00", "every", 15);
    insert.run(2, "student", "B", null, 1, "08:00", "09:00", "every", 15);
    db.prepare("INSERT INTO profiles (telegram_id, display_name, reminders_enabled) VALUES (1, 'Off', 0), (2, 'On', 1)").run();
    const chats: number[] = [];
    expect(await sendDueReminders(db, async (chatId) => { chats.push(chatId); }, AT_0745, silent)).toBe(1);
    expect(chats).toEqual([2]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM lessons WHERE notifications_enabled=1").get()).toEqual({ c: 2 });
  });

  it("does not resend when the start time is edited after the reminder went out", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 15);
    const sent: string[] = [];
    const send = async (_chatId: number, text: string) => { sent.push(text); };
    expect(await sendDueReminders(db, send, AT_0745, silent)).toBe(1);
    // The user moves the lesson to 08:10: its reminder moment (07:55) must not re-arm the same day.
    db.prepare("UPDATE lessons SET start_time='08:10', end_time='09:40' WHERE id=1").run();
    expect(await sendDueReminders(db, send, new Date(AT_0745.getTime() + 10 * 60_000), silent)).toBe(0);
    expect(sent).toEqual(["🔔 În 15 minute: Fizică\n08:00–09:30"]);
    expect(db.prepare("SELECT occurrence_key AS key FROM delivered_reminders").all()).toEqual([{ key: "2026-09-14" }]);
    // The next occurrence, a week later, is a different day and is sent again.
    expect(await sendDueReminders(db, send, new Date(AT_0745.getTime() + 7 * 1440 * 60_000 + 10 * 60_000), silent)).toBe(1);
  });

  it("recovers a reminder missed during a ten-minute restart, only once", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 15);
    const sent: string[] = [];
    const send = async (_chatId: number, text: string) => { sent.push(text); };
    const at = (minutesAfter0745: number) => new Date(AT_0745.getTime() + minutesAfter0745 * 60_000);
    // Process down from 07:44 to 07:54; the first tick back catches up with the real countdown.
    expect(await sendDueReminders(db, send, at(9), silent)).toBe(1);
    expect(await sendDueReminders(db, send, at(10), silent)).toBe(0);
    expect(sent).toEqual(["🔔 În 6 minute: Fizică\n08:00–09:30"]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE kind='reminder'").get()).toEqual({ c: 1 });
  });

  it("prunes old reminder bookkeeping in both the current and the legacy key format", () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 15);
    db.prepare("INSERT INTO delivered_reminders VALUES (1, '2026-08-01'), (1, '2026-08-01-08:00'), (1, '2026-09-14'), (1, '2026-08-31')").run();
    // Keep-days is 14: the cutoff for 14 Sept is 31 Aug, so only the two August keys go.
    expect(pruneDatabase(db, "2026-09-14").reminders).toBe(2);
    expect(db.prepare("SELECT occurrence_key AS key FROM delivered_reminders ORDER BY key").all()).toEqual([{ key: "2026-08-31" }, { key: "2026-09-14" }]);
  });

  it("stays silent on a non-working day and outside every semester", async () => {
    const { db, insert } = setup();
    insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 15);
    const send = async () => { throw new Error("nu trebuie trimis nimic"); };
    // A day marked by an administrator: the lesson stays in the schedule, only the reminder is skipped.
    setNonWorkingDay(db, "2026-09-14", "Vacanță de toamnă");
    expect(await sendDueReminders(db, send, AT_0745, silent)).toBe(0);

    const working = setup();
    working.insert.run(1, "student", "Fizică", null, 1, "08:00", "09:30", "every", 15);
    const previous = process.env.SEMESTERS;
    try {
      // The semester ended on 10 Sept 2026, so 14 Sept is between semesters — no reminder is due.
      process.env.SEMESTERS = "2026-09-07:even:2026-09-10";
      expect(await sendDueReminders(working.db, send, AT_0745, silent)).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.SEMESTERS; else process.env.SEMESTERS = previous;
    }
    const sent: string[] = [];
    expect(await sendDueReminders(working.db, async (_c, text) => { sent.push(text); }, AT_0745, silent)).toBe(1);
  });

  it("skips a seeded public holiday", async () => {
    const { db, insert } = setup();
    seedLegalHolidays(db, 2027);
    // 1 January 2027 is a Friday (Anul Nou).
    insert.run(1, "student", "Fizică", null, 5, "08:00", "09:30", "every", 15);
    const send = async () => { throw new Error("nu trebuie trimis nimic"); };
    expect(await sendDueReminders(db, send, new Date("2027-01-01T05:45:00Z"), silent)).toBe(0);
    // A Friday in the same month without a holiday is an ordinary teaching day.
    const sent: string[] = [];
    expect(await sendDueReminders(db, async (_c, text) => { sent.push(text); }, new Date("2027-01-15T05:45:00Z"), silent)).toBe(1);
  });
});

describe("minutesLabel", () => {
  it("follows Romanian number agreement", () => {
    expect([1, 2, 19, 20, 101, 119, 120, 100].map(minutesLabel)).toEqual([
      "1 minut", "2 minute", "19 minute", "20 de minute", "101 minute", "119 minute", "120 de minute", "100 de minute"
    ]);
  });

});
