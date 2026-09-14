import { describe, expect, it } from "vitest";
import { botReply, pollingBackoff } from "./bot.js";
import { openDatabase } from "./db.js";
import { TelegramApiError } from "./telegram.js";

const NOW = new Date("2026-09-14T06:00:00Z"); // Monday, odd week
const message = (text: string, chatType = "private") => ({ text, chat: { id: 42, type: chatType }, from: { id: 42, first_name: "Ion" } });

describe("botReply", () => {
  it("answers commands in private chats and ignores groups, bots and plain text", () => {
    const db = openDatabase(":memory:");
    expect(botReply(db, message("/start"), NOW)?.text).toContain("/azi");
    expect(botReply(db, message("/start", "group"), NOW)).toBeNull();
    expect(botReply(db, message("hello"), NOW)).toBeNull();
    expect(botReply(db, { ...message("/start"), from: { id: 42, first_name: "Bot", is_bot: true } }, NOW)).toBeNull();
    expect(botReply(db, undefined, NOW)).toBeNull();
  });
  it("lists today's lessons for the current parity and updates the sender's own data", () => {
    const db = openDatabase(":memory:");
    const insert = db.prepare("INSERT INTO lessons (owner_id, role, title, weekday, start_time, end_time, week_kind) VALUES (?,?,?,?,?,?,?)");
    insert.run(42, "student", "Fizică", 1, "08:00", "09:30", "odd");
    insert.run(42, "student", "Chimie", 1, "10:00", "11:30", "even");
    insert.run(7, "student", "Altcineva", 1, "08:00", "09:30", "every");
    const today = botReply(db, message("/azi"), NOW)?.text ?? "";
    expect(today).toContain("săptămână impară");
    expect(today).toContain("Fizică");
    expect(today).not.toContain("Chimie");
    expect(today).not.toContain("Altcineva");
    botReply(db, message("/rol profesor"), NOW);
    expect(db.prepare("SELECT role FROM profiles WHERE telegram_id=42").get()).toEqual({ role: "teacher" });
    botReply(db, message("/notificari off"), NOW);
    expect(db.prepare("SELECT COUNT(*) AS c FROM lessons WHERE notifications_enabled=1").get()).toEqual({ c: 1 });
  });
});

describe("pollingBackoff", () => {
  it("backs off exponentially and honours Telegram hints", () => {
    expect(pollingBackoff(new Error("network"), 0)).toBe(1_000);
    expect(pollingBackoff(new Error("network"), 1_000)).toBe(2_000);
    expect(pollingBackoff(new Error("network"), 60_000)).toBe(60_000);
    expect(pollingBackoff(new TelegramApiError("conflict", 409), 0)).toBe(30_000);
    expect(pollingBackoff(new TelegramApiError("too many", 429, 7), 0)).toBe(7_000);
  });
});
