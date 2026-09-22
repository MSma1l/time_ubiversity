import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { asUpdateList, BOT_COMMAND_LIMIT, BOT_COMMANDS, botReply, handleBotMessage, pollingBackoff, registerBotCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { TelegramApiError } from "./telegram.js";

const NOW = new Date("2026-09-14T06:00:00Z"); // Monday, odd week
const message = (text: string, chatType = "private") => ({ text, chat: { id: 42, type: chatType }, from: { id: 42, first_name: "Ion" } });

describe("botReply", () => {
  it("answers commands in private chats, helps on free text and ignores groups and bots", () => {
    const db = openDatabase(":memory:");
    expect(botReply(db, message("/start"), NOW)?.text).toContain("/azi");
    expect(botReply(db, message("/start"), NOW)?.text).toContain("Orar Univer");
    expect(botReply(db, message("/start"), NOW)?.text).not.toContain("UTM");
    expect(botReply(db, message("/start", "group"), NOW)).toBeNull();
    expect(botReply(db, message("hello"), NOW)?.text).toContain("/help");
    expect(botReply(db, message("hello", "group"), NOW)).toBeNull();
    expect(botReply(db, message("   "), NOW)).toBeNull();
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
    db.prepare("UPDATE lessons SET notifications_enabled=0 WHERE title='Chimie'").run();
    botReply(db, message("/notificari off"), NOW);
    // Only the profile flag changes; per-lesson settings are untouched.
    expect(db.prepare("SELECT reminders_enabled AS r FROM profiles WHERE telegram_id=42").get()).toEqual({ r: 0 });
    expect(db.prepare("SELECT title FROM lessons WHERE notifications_enabled=1 ORDER BY title").all()).toEqual([{ title: "Altcineva" }, { title: "Fizică" }]);
    botReply(db, message("/notificari on"), NOW);
    expect(db.prepare("SELECT reminders_enabled AS r FROM profiles WHERE telegram_id=42").get()).toEqual({ r: 1 });
    expect(db.prepare("SELECT title FROM lessons WHERE notifications_enabled=1 ORDER BY title").all()).toEqual([{ title: "Altcineva" }, { title: "Fizică" }]);
  });
});

describe("botReply schedules", () => {
  it("shows only the lessons of the active role", () => {
    const db = openDatabase(":memory:");
    const insert = db.prepare("INSERT INTO lessons (owner_id, role, title, weekday, start_time, end_time, week_kind) VALUES (?,?,?,?,?,?,?)");
    insert.run(42, "student", "Fizică", 1, "08:00", "09:30", "every");
    insert.run(42, "teacher", "Rețele", 1, "11:30", "13:00", "every");
    const student = botReply(db, message("/azi"), NOW)?.text ?? "";
    expect(student).toContain("Fizică");
    expect(student).not.toContain("Rețele");
    botReply(db, message("/rol profesor"), NOW);
    const teacher = botReply(db, message("/saptamana"), NOW)?.text ?? "";
    expect(teacher).toContain("Profesor");
    expect(teacher).toContain("Rețele");
    expect(teacher).not.toContain("Fizică");
  });
});

describe("botReply usage and profile rules", () => {
  it("explains /rol and /notificari usage when the argument is missing or invalid", () => {
    const db = openDatabase(":memory:");
    for (const text of ["/rol", "/rol admin"]) {
      const answer = botReply(db, message(text), NOW)?.text ?? "";
      expect(answer).toContain("/rol student");
      expect(answer).not.toContain("Nu cunosc");
    }
    for (const text of ["/notificari", "/notificari maybe"]) {
      const answer = botReply(db, message(text), NOW)?.text ?? "";
      expect(answer).toContain("/notificari on");
      expect(answer).not.toContain("Nu cunosc");
    }
    expect(botReply(db, message("/nimic"), NOW)?.text).toContain("Nu cunosc");
  });

  it("treats prototype keys as an invalid /rol argument instead of crashing", () => {
    const db = openDatabase(":memory:");
    for (const text of ["/rol __proto__", "/rol constructor", "/rol toString", "/rol hasOwnProperty"]) {
      const answer = botReply(db, message(text), NOW)?.text ?? "";
      expect(answer).toContain("/rol student");
    }
    expect(db.prepare("SELECT role FROM profiles WHERE telegram_id=42").get()).toEqual({ role: "student" });
  });

  it("refuses /rol for a disabled mode and keeps the active role", () => {
    const db = openDatabase(":memory:");
    botReply(db, message("/start"), NOW);
    db.prepare("UPDATE profiles SET teacher_enabled=0 WHERE telegram_id=42").run();
    expect(botReply(db, message("/rol profesor"), NOW)?.text).toContain("Modul Profesor este dezactivat. Activează-l mai întâi.");
    expect(db.prepare("SELECT role FROM profiles WHERE telegram_id=42").get()).toEqual({ role: "student" });
    expect(botReply(db, message("/rol student"), NOW)?.text).toContain("Mod activ: Student");
  });
});

describe("registerBotCommands", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("registers Romanian commands once when a token is set and ignores failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const silent = { warn: () => undefined };
    expect(await registerBotCommands(loadConfig({}), undefined, silent)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1" });
    expect(await registerBotCommands(config, undefined, silent)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/setMyCommands$/);
    expect(JSON.parse(String(init.body)).commands).toEqual(BOT_COMMANDS);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, description: "bad" }), { status: 400 }));
    expect(await registerBotCommands(config, undefined, silent)).toBe(false);
  });
});

describe("handleBotMessage", () => {
  const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  const ok = () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const fail = (status: number, parameters?: { retry_after: number }) => new Response(JSON.stringify({ ok: false, description: "nope", parameters }), { status });
  const flood = (id: number) => ({ text: "/status", chat: { id, type: "private" }, from: { id, first_name: "Ion" } });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("drops a sender's messages in silence past the per-minute limit", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const db = openDatabase(":memory:");
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN });
    for (let i = 0; i < BOT_COMMAND_LIMIT + 5; i += 1) await handleBotMessage(db, config, flood(4242));
    expect(fetchMock).toHaveBeenCalledTimes(BOT_COMMAND_LIMIT);
    // The limit is per sender: another user is unaffected.
    await handleBotMessage(db, config, flood(4343));
    expect(fetchMock).toHaveBeenCalledTimes(BOT_COMMAND_LIMIT + 1);
  });

  it("retries a reply once on 429/5xx but not on a client error", async () => {
    const db = openDatabase(":memory:");
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN });
    const transient = vi.fn(async () => (transient.mock.calls.length === 1 ? fail(500) : ok()));
    vi.stubGlobal("fetch", transient);
    await handleBotMessage(db, config, flood(5151));
    expect(transient).toHaveBeenCalledTimes(2);
    const forbidden = vi.fn(async () => fail(403));
    vi.stubGlobal("fetch", forbidden);
    await expect(handleBotMessage(db, config, flood(5252))).rejects.toThrow(/403/);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});

describe("asUpdateList", () => {
  it("passes arrays through and names the payload when getUpdates returns anything else", () => {
    expect(asUpdateList([])).toEqual([]);
    expect(asUpdateList([{ update_id: 1 }])).toEqual([{ update_id: 1 }]);
    for (const value of [undefined, null, true, { ok: true }]) expect(() => asUpdateList(value)).toThrow(/getUpdates/);
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
