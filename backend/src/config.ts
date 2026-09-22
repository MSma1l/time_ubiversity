import { parseSemesters, type Semester } from "./schedule.js";

export type AppConfig = {
  production: boolean;
  port: number;
  host: string;
  token: string;
  miniAppUrl: string;
  databasePath: string;
  databaseUrl: string;
  allowDevAuth: boolean;
  origins: string[];
  polling: boolean;
  webhookUrl: string;
  webhookSecret: string;
  trustProxy: string | number | boolean;
  initDataMaxAgeSeconds: number;
  rateLimitPerMinute: number;
  /** Teaching periods, in order; parity restarts at every semester (see schedule.ts). */
  semesters: Semester[];
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
  }
}

function flag(value: string | undefined, fallback = false) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, problems: string[]) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function parseTrustProxy(raw: string | undefined): string | number | boolean {
  const value = raw?.trim();
  // Default: trust only private/loopback hops (nginx inside the Docker network).
  if (!value) return "loopback, linklocal, uniquelocal";
  if (value === "true") return true;
  if (value === "false") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Reads and validates the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const allowDevAuth = flag(env.ALLOW_DEV_AUTH);
  const polling = flag(env.TELEGRAM_POLLING);
  const miniAppUrl = env.MINI_APP_URL?.trim() ?? "";
  const webhookUrl = env.WEBHOOK_URL?.trim() ?? "";
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";

  if (production && !token) problems.push("TELEGRAM_BOT_TOKEN is required when NODE_ENV=production");
  if (production && allowDevAuth) problems.push("ALLOW_DEV_AUTH=true is not allowed when NODE_ENV=production");
  if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) problems.push("TELEGRAM_BOT_TOKEN does not look like a BotFather token");
  if (miniAppUrl && !/^https?:\/\/[^\s]+$/i.test(miniAppUrl)) problems.push("MINI_APP_URL must be an absolute http(s) URL");
  if (webhookUrl && !/^https:\/\/[^\s]+$/i.test(webhookUrl)) problems.push("WEBHOOK_URL must be an https:// URL");
  if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) problems.push("TELEGRAM_WEBHOOK_SECRET may contain only A-Z, a-z, 0-9, _ and - (max 256 chars)");

  // Format: START:even|odd[:END], comma separated — "2026-09-07:even:2026-12-20,2027-02-08:even:2027-05-30".
  // An empty value keeps the built-in default (schedule.ts). Helpers read the variable themselves, so the
  // validation here is what turns a typo into a startup error instead of a silently wrong parity.
  const { semesters, problems: semesterProblems } = parseSemesters(env.SEMESTERS);
  problems.push(...semesterProblems);

  const config: AppConfig = {
    production,
    port: integer(env, "PORT", 3001, 1, 65_535, problems),
    host: env.HOST?.trim() || "0.0.0.0",
    token,
    miniAppUrl,
    databasePath: env.DATABASE_PATH?.trim() || "./data/orar.sqlite",
    databaseUrl: env.DATABASE_URL?.trim() ?? "",
    allowDevAuth,
    origins: (env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean),
    polling,
    webhookUrl,
    webhookSecret,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // One hour: `initData` is a bearer credential with no revocation, so the replay window stays short.
    initDataMaxAgeSeconds: integer(env, "INIT_DATA_MAX_AGE_SECONDS", 3_600, 60, 7 * 86_400, problems),
    rateLimitPerMinute: integer(env, "RATE_LIMIT_PER_MINUTE", 120, 0, 100_000, problems),
    semesters
  };
  if (problems.length) throw new ConfigError(problems);
  return config;
}

/** Telegram only accepts https URLs for web_app buttons. */
export function miniAppButton(config: Pick<AppConfig, "miniAppUrl">, text: string) {
  return config.miniAppUrl.startsWith("https://") ? { inline_keyboard: [[{ text, web_app: { url: config.miniAppUrl } }]] } : undefined;
}
