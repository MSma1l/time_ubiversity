import { miniAppButton, type AppConfig } from "./config.js";
import { lessonRows, upsertProfile, type Lesson, type SqliteDatabase } from "./db.js";
import { ProfileRuleError, readProfile, updateProfile } from "./profile.js";
import { createRateLimiter } from "./rateLimit.js";
import { appliesInWeek, chisinauClock, universityWeekKind } from "./schedule.js";
import { sleep } from "./util.js";
import { deriveWebhookSecret, telegramApi, telegramApiResponse, TelegramApiError, type TelegramUser } from "./telegram.js";

export type TelegramMessage = { text?: string, chat?: { id: number, type?: string }, from?: TelegramUser & { is_bot?: boolean } };
export type TelegramUpdate = { update_id: number, message?: TelegramMessage };

const ROLE_NAMES: Record<Lesson["role"], string> = { student: "Student", teacher: "Profesor" };

/** Canonical product name (frontend/index.html <title>). */
export const APP_NAME = "Orar Univer";

/** Command menu registered with Telegram via setMyCommands. */
export const BOT_COMMANDS = [
  { command: "azi", description: "Orarul de azi" },
  { command: "saptamana", description: "Orarul săptămânii curente" },
  { command: "rol", description: "Schimbă modul: student sau profesor" },
  { command: "notificari", description: "Pornește sau oprește memento-urile" },
  { command: "status", description: "Starea contului" },
  { command: "help", description: "Lista comenzilor" }
] as const;

const HELP_TEXT = `Bun venit la ${APP_NAME}!\n\n/azi — orarul de azi\n/saptamana — orarul săptămânii curente\n/rol student|profesor — schimbă modul activ\n/notificari on|off — pornește/oprește memento-urile\n/status — starea contului`;
const FREE_TEXT_REPLY = `Sunt botul ${APP_NAME} și răspund doar la comenzi. Trimite /help pentru lista comenzilor sau deschide orarul în aplicație.`;
// A Map (not an object literal) so `/rol __proto__` or `/rol constructor` cannot reach Object.prototype.
const ROLE_ARGUMENTS = new Map<string, Lesson["role"]>([["student", "student"], ["profesor", "teacher"], ["teacher", "teacher"]]);

/** Bot commands accepted per sender each minute; extra messages are dropped without an answer. */
export const BOT_COMMAND_LIMIT = 20;
/** Flood guard shared by the webhook route and the polling loop (neither passes through /api). */
export const botCommandLimiter = createRateLimiter(BOT_COMMAND_LIMIT);

function formatLesson(lesson: Lesson) { return `• ${lesson.startTime}–${lesson.endTime} — ${lesson.title}${lesson.room ? ` (sala ${lesson.room})` : ""}`; }

/**
 * Computes the bot's answer and applies command side effects. Data is always keyed by the
 * sender (`from.id`); only private chats are handled so personal schedules are never posted
 * into groups. Free text in a private chat gets a short help reply.
 */
export function botReply(db: SqliteDatabase, message: TelegramMessage | undefined, now = new Date()): { chatId: number, text: string } | null {
  const chatId = message?.chat?.id; const from = message?.from; const text = message?.text?.trim() ?? "";
  if (!message || !chatId || !from || from.is_bot || !Number.isSafeInteger(from.id) || message.chat?.type !== "private" || !text) return null;
  if (!text.startsWith("/")) return { chatId, text: FREE_TEXT_REPLY };
  const userId = from.id;
  const words = text.split(/\s+/);
  const command = words[0].split("@")[0].toLowerCase(); const argument = words.slice(1).join(" ").toLowerCase();
  upsertProfile(db, { id: userId, first_name: typeof from.first_name === "string" ? from.first_name : "", last_name: typeof from.last_name === "string" ? from.last_name : undefined });
  const profile = readProfile(db, userId);
  // The schedule the bot shows is the one of the profile's active role (as in the Mini App).
  const role: Lesson["role"] = profile?.role === "teacher" ? "teacher" : "student";
  const clock = chisinauClock(now); const kind = universityWeekKind(clock.date);
  const kindLabel = kind === "even" ? "pară" : "impară";
  let answer = "";
  if (command === "/start" || command === "/help") answer = HELP_TEXT;
  else if (command === "/azi") {
    const todayLessons = lessonRows(db, userId, role).filter((lesson) => lesson.weekday === clock.weekday && appliesInWeek(lesson.weekKind, clock.date));
    answer = todayLessons.length ? `📚 Orarul de azi · ${ROLE_NAMES[role]} (săptămână ${kindLabel}):\n${todayLessons.map(formatLesson).join("\n")}` : `☀️ Ești liber azi — nu ai nicio pereche programată în orarul de ${ROLE_NAMES[role]}.`;
  } else if (command === "/saptamana") {
    const entries = lessonRows(db, userId, role).filter((lesson) => appliesInWeek(lesson.weekKind, clock.date));
    answer = entries.length ? `📅 Săptămâna ${kindLabel} · ${ROLE_NAMES[role]}:\n${entries.map((lesson) => `${["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"][lesson.weekday - 1]} ${formatLesson(lesson)}`).join("\n")}` : `Nu ai ore în această săptămână în orarul de ${ROLE_NAMES[role]}.`;
  } else if (command === "/rol") {
    const requested = ROLE_ARGUMENTS.get(argument);
    if (!requested) answer = `Folosește: /rol student sau /rol profesor.\nMod activ: ${ROLE_NAMES[role]}.`;
    else {
      try {
        answer = `Mod activ: ${ROLE_NAMES[updateProfile(db, userId, { role: requested }).role]}.`;
      } catch (error) {
        if (!(error instanceof ProfileRuleError)) throw error;
        answer = `${error.message} Poți activa modurile din aplicație (Profil).`;
      }
    }
  } else if (command === "/notificari") {
    if (argument === "on" || argument === "off") {
      updateProfile(db, userId, { remindersEnabled: argument === "on" });
      answer = argument === "on" ? "🔔 Memento-urile sunt active." : "🔕 Memento-urile sunt oprite. Setările fiecărei ore rămân neschimbate.";
    } else answer = `Folosește: /notificari on sau /notificari off.\nMemento-uri: ${profile?.remindersEnabled === false ? "oprite" : "active"}.`;
  } else if (command === "/status") {
    const modes = [profile?.studentEnabled !== false && "Student", profile?.teacherEnabled !== false && "Profesor"].filter(Boolean).join(", ");
    answer = `Cont activ · mod: ${ROLE_NAMES[role]} · moduri disponibile: ${modes} · memento-uri: ${profile?.remindersEnabled === false ? "oprite" : "active"} · săptămână ${kindLabel}.`;
  } else answer = "Nu cunosc această comandă. Trimite /help pentru lista comenzilor.";
  return { chatId, text: answer };
}

export async function handleBotMessage(db: SqliteDatabase, config: AppConfig, message: TelegramMessage | undefined, signal?: AbortSignal) {
  if (!config.token) return;
  const senderId = message?.from?.id;
  // Checked before any SQLite write; over the limit we stay silent, since answering amplifies the flood.
  if (Number.isSafeInteger(senderId) && botCommandLimiter.hit(String(senderId))) return;
  const reply = botReply(db, message);
  if (!reply) return;
  await sendMessage(config, { chat_id: reply.chatId, text: reply.text, reply_markup: miniAppButton(config, "Deschide orarul") }, signal);
}

/** Sends one reply, retrying exactly once on a transient 429/5xx so the answer is not lost. */
async function sendMessage(config: AppConfig, payload: Record<string, unknown>, signal?: AbortSignal) {
  try {
    await telegramApi(config.token, "sendMessage", payload, signal);
  } catch (error) {
    const transient = error instanceof TelegramApiError && (error.status === 429 || error.status >= 500);
    if (!transient) throw error;
    const retryAfter = (error as TelegramApiError).retryAfterSeconds;
    await sleep(retryAfter ? Math.min(retryAfter, 30) * 1_000 : 500, signal);
    if (signal?.aborted) return;
    await telegramApi(config.token, "sendMessage", payload, signal);
  }
}

/** Registers the Romanian command menu once at startup. Failures are logged and ignored. */
export async function registerBotCommands(config: AppConfig, signal?: AbortSignal, log: Pick<Console, "warn"> = console) {
  if (!config.token) return false;
  try {
    await telegramApi(config.token, "setMyCommands", { commands: BOT_COMMANDS }, signal);
    return true;
  } catch (error) {
    if (!signal?.aborted) log.warn("Telegram setMyCommands failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

export function webhookSecret(config: AppConfig) {
  return config.webhookSecret || deriveWebhookSecret(config.token);
}

/** Registers WEBHOOK_URL with Telegram (webhook mode only), retrying in the background. */
export async function configureWebhook(config: AppConfig, signal: AbortSignal, log: Pick<Console, "log" | "warn" | "error"> = console) {
  if (!config.token || config.polling || !config.webhookUrl) return;
  for (let delay = 5_000; !signal.aborted; delay = Math.min(delay * 2, 300_000)) {
    try {
      await telegramApi(config.token, "setWebhook", { url: config.webhookUrl, secret_token: webhookSecret(config), allowed_updates: ["message"] }, signal);
      log.log(`Telegram webhook registered: ${config.webhookUrl}`);
      return;
    } catch (error) {
      if (signal.aborted) return;
      log.error("Telegram setWebhook failed:", error instanceof Error ? error.message : error);
      await sleep(delay, signal);
    }
  }
}

/** Guards a malformed getUpdates payload so the log names the cause instead of a generic TypeError. */
export function asUpdateList(result: unknown): TelegramUpdate[] {
  if (!Array.isArray(result)) throw new Error(`Telegram getUpdates returned an unexpected payload (expected an array, got ${result === null ? "null" : typeof result})`);
  return result as TelegramUpdate[];
}

/** Polling delay after a failed getUpdates call. */
export function pollingBackoff(error: unknown, previousDelayMs: number): number {
  if (error instanceof TelegramApiError) {
    if (error.retryAfterSeconds) return error.retryAfterSeconds * 1000;
    if (error.status === 409) return 30_000; // another getUpdates consumer or an active webhook
    if (error.status === 401 || error.status === 404) return 300_000; // invalid bot token
  }
  return Math.min(Math.max(previousDelayMs * 2, 1_000), 60_000);
}

export function startPolling(db: SqliteDatabase, config: AppConfig, log: Pick<Console, "log" | "warn" | "error"> = console) {
  const controller = new AbortController();
  const { signal } = controller;
  const loop = (async () => {
    // getUpdates is rejected (409) while a webhook is set; polling mode means we own the updates.
    try {
      await telegramApi(config.token, "deleteWebhook", { drop_pending_updates: false }, signal);
    } catch (error) {
      if (!signal.aborted) log.warn("Telegram deleteWebhook failed:", error instanceof Error ? error.message : error);
    }
    let offset = 0; let delay = 0;
    while (!signal.aborted) {
      try {
        const updates = asUpdateList(await telegramApiResponse<unknown>(config.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal));
        delay = 0;
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          try { await handleBotMessage(db, config, update.message, signal); } catch (error) {
            if (!signal.aborted) log.error("Telegram message handling failed:", error instanceof Error ? error.message : error);
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        delay = pollingBackoff(error, delay);
        const conflict = error instanceof TelegramApiError && error.status === 409;
        log.error(conflict
          ? "Telegram polling conflict (409): another instance is polling with this bot token, or a webhook is active. Retrying later."
          : "Telegram polling error:", conflict ? "" : error instanceof Error ? error.message : error);
        await sleep(delay, signal);
      }
    }
  })();
  return {
    async stop() {
      controller.abort();
      await loop.catch(() => undefined);
    }
  };
}
