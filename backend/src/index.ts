import "dotenv/config";
import type { Server } from "node:http";
import cron from "node-cron";
import { closeAcademicDatabase, initAcademicWithRetry } from "./academic.js";
import { createApp } from "./app.js";
import { configureWebhook, registerBotCommands, startPolling } from "./bot.js";
import { ConfigError, loadConfig, miniAppButton, type AppConfig } from "./config.js";
import { openDatabase, pruneDatabase, type SqliteDatabase } from "./db.js";
import { sendDueReminders } from "./reminders.js";
import { isoDateInChisinau, UNIVERSITY_TIMEZONE } from "./schedule.js";
import { telegramApi } from "./telegram.js";

process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception, exiting:", error);
  process.exit(1);
});

let config: AppConfig;
let db: SqliteDatabase;
try {
  config = loadConfig();
  db = openDatabase(config.databasePath);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `Startup failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

if (!config.token) console.warn("TELEGRAM_BOT_TOKEN is not set: Telegram authentication, reminders and the bot are disabled");
if (config.allowDevAuth) console.warn("ALLOW_DEV_AUTH=true: X-Dev-Telegram-Id is accepted. Never enable this in production.");
if (config.miniAppUrl && !config.miniAppUrl.startsWith("https://")) console.warn("MINI_APP_URL is not https: Telegram buttons that open the Mini App are omitted");
if (config.token && !config.polling && !config.webhookUrl) console.warn("Neither TELEGRAM_POLLING=true nor WEBHOOK_URL is set: the bot will not receive commands");

const lifecycle = new AbortController();
void initAcademicWithRetry(config.databaseUrl, lifecycle.signal);

const app = createApp({ db, config });
const server: Server = app.listen(config.port, config.host, () => console.log(`Orar API listens on ${config.host}:${config.port}`));
server.on("error", (error) => {
  console.error(`HTTP server error: ${error.message}`);
  process.exit(1);
});

let reminderRun: Promise<unknown> = Promise.resolve();
let reminderRunning = false;
const reminderTask = cron.schedule("* * * * *", () => {
  if (!config.token || reminderRunning || lifecycle.signal.aborted) return;
  reminderRunning = true;
  reminderRun = sendDueReminders(db, (chatId, text) => telegramApi(config.token, "sendMessage", { chat_id: chatId, text, reply_markup: miniAppButton(config, "Deschide orarul") }, lifecycle.signal))
    .catch((error) => console.error("Reminder run failed:", error))
    .finally(() => { reminderRunning = false; });
}, { timezone: UNIVERSITY_TIMEZONE, name: "reminders" });

const maintenanceTask = cron.schedule("17 4 * * *", () => {
  try {
    const removed = pruneDatabase(db, isoDateInChisinau());
    if (removed.reminders || removed.notifications) console.log(`Maintenance: removed ${removed.reminders} reminder records and ${removed.notifications} old notifications`);
  } catch (error) { console.error("Maintenance failed:", error); }
}, { timezone: UNIVERSITY_TIMEZONE, name: "maintenance" });

const polling = config.polling && config.token ? startPolling(db, config) : undefined;
if (config.polling && !config.token) console.warn("TELEGRAM_POLLING=true but TELEGRAM_BOT_TOKEN is empty: polling is disabled");
void configureWebhook(config, lifecycle.signal);
if (config.token) void registerBotCommands(config, lifecycle.signal);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    lifecycle.abort();
    await reminderTask.stop();
    await maintenanceTask.stop();
    await polling?.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await reminderRun;
    await closeAcademicDatabase().catch((error) => console.error("PostgreSQL close failed:", error));
    db.close();
    console.log("Shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed:", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
