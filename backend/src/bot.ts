import { miniAppButton, type AppConfig } from "./config.js";
import { lessonRows, upsertProfile, type Lesson, type SqliteDatabase } from "./db.js";
import { appliesInWeek, chisinauClock, universityWeekKind } from "./schedule.js";
import { sleep } from "./util.js";
import { deriveWebhookSecret, telegramApi, telegramApiResponse, TelegramApiError, type TelegramUser } from "./telegram.js";

export type TelegramMessage = { text?: string, chat?: { id: number, type?: string }, from?: TelegramUser & { is_bot?: boolean } };
export type TelegramUpdate = { update_id: number, message?: TelegramMessage };

const ROLE_NAMES: Record<Lesson["role"], string> = { student: "Student", teacher: "Profesor" };

/** The schedule the bot shows is the one of the profile's active role (as in the Mini App). */
function activeRole(db: SqliteDatabase, userId: number): Lesson["role"] {
  const profile = db.prepare("SELECT role FROM profiles WHERE telegram_id=?").get(userId) as { role?: string } | undefined;
  return profile?.role === "teacher" ? "teacher" : "student";
}

function formatLesson(lesson: Lesson) { return `• ${lesson.startTime}–${lesson.endTime} — ${lesson.title}${lesson.room ? ` (sala ${lesson.room})` : ""}`; }

/**
 * Computes the bot's answer and applies command side effects. Data is always keyed by the
 * sender (`from.id`); only private chats are handled so personal schedules are never posted
 * into groups.
 */
export function botReply(db: SqliteDatabase, message: TelegramMessage | undefined, now = new Date()): { chatId: number, text: string } | null {
  const chatId = message?.chat?.id; const from = message?.from; const text = message?.text?.trim() ?? "";
  if (!message || !chatId || !from || from.is_bot || !Number.isSafeInteger(from.id) || message.chat?.type !== "private" || !text.startsWith("/")) return null;
  const userId = from.id;
  const words = text.split(/\s+/);
  const command = words[0].split("@")[0].toLowerCase(); const argument = words.slice(1).join(" ").toLowerCase();
  upsertProfile(db, { id: userId, first_name: typeof from.first_name === "string" ? from.first_name : "", last_name: typeof from.last_name === "string" ? from.last_name : undefined });
  const clock = chisinauClock(now); const kind = universityWeekKind(clock.date);
  const kindLabel = kind === "even" ? "pară" : "impară";
  let answer = "";
  if (command === "/start" || command === "/help") answer = "Bun venit la Orar UTM!\n\n/azi — orarul de azi\n/saptamana — orarul săptămânii curente\n/rol student|profesor — schimbă rolul\n/notificari on|off — activează/dezactivează memento-urile\n/status — starea contului";
  else if (command === "/azi") {
    const role = activeRole(db, userId);
    const todayLessons = lessonRows(db, userId, role).filter((lesson) => lesson.weekday === clock.weekday && appliesInWeek(lesson.weekKind, clock.date));
    answer = todayLessons.length ? `📚 Orarul de azi · ${ROLE_NAMES[role]} (săptămână ${kindLabel}):\n${todayLessons.map(formatLesson).join("\n")}` : `☀️ Ești liber azi — nu ai nicio pereche programată în orarul de ${ROLE_NAMES[role]}.`;
  } else if (command === "/saptamana") {
    const role = activeRole(db, userId);
    const entries = lessonRows(db, userId, role).filter((lesson) => appliesInWeek(lesson.weekKind, clock.date));
    answer = entries.length ? `📅 Săptămâna ${kindLabel} · ${ROLE_NAMES[role]}:\n${entries.map((lesson) => `${["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"][lesson.weekday - 1]} ${formatLesson(lesson)}`).join("\n")}` : `Nu ai ore în această săptămână în orarul de ${ROLE_NAMES[role]}.`;
  } else if (command === "/rol" && (argument === "student" || argument === "profesor")) {
    db.prepare("UPDATE profiles SET role=? WHERE telegram_id=?").run(argument === "profesor" ? "teacher" : "student", userId);
    answer = `Rol activ: ${argument}.`;
  } else if (command === "/notificari" && (argument === "on" || argument === "off")) {
    db.prepare("UPDATE lessons SET notifications_enabled=?, updated_at=CURRENT_TIMESTAMP WHERE owner_id=?").run(argument === "on" ? 1 : 0, userId);
    answer = argument === "on" ? "🔔 Memento-urile sunt active." : "🔕 Memento-urile sunt oprite.";
  } else if (command === "/status") {
    const profile = db.prepare("SELECT role FROM profiles WHERE telegram_id=?").get(userId) as { role?: string } | undefined;
    answer = `Cont activ · rol: ${profile?.role === "teacher" ? "profesor" : "student"} · săptămână ${kindLabel}.`;
  } else answer = "Nu cunosc această comandă. Trimite /help pentru lista comenzilor.";
  return { chatId, text: answer };
}

export async function handleBotMessage(db: SqliteDatabase, config: AppConfig, message: TelegramMessage | undefined, signal?: AbortSignal) {
  if (!config.token) return;
  const reply = botReply(db, message);
  if (!reply) return;
  await telegramApi(config.token, "sendMessage", { chat_id: reply.chatId, text: reply.text, reply_markup: miniAppButton(config, "Deschide orarul") }, signal);
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
        const updates = await telegramApiResponse<TelegramUpdate[]>(config.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal);
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
