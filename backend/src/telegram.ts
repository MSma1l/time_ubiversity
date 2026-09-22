import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TelegramUser = { id: number; first_name: string; last_name?: string; username?: string };

/** Allowed clock skew for an auth_date slightly in the future (server/Telegram clocks drift). */
const FUTURE_SKEW_SECONDS = 60;

/**
 * Validates Telegram Mini App initData as described in
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string, botToken: string, maxAgeSeconds = 3_600, nowMs = Date.now()): TelegramUser | null {
  if (!initData || !botToken || initData.length > 8_192) return null;
  const values = new URLSearchParams(initData);
  // Telegram never repeats a key; a duplicate makes `.get()` (first value) and the signed
  // check string (all values) disagree, so the whole input is ambiguous — reject it.
  const keys = [...values.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const suppliedHash = values.get("hash");
  const authDate = Number(values.get("auth_date"));
  const userJson = values.get("user");
  if (!suppliedHash || !/^[0-9a-f]{64}$/i.test(suppliedHash) || !userJson || !Number.isInteger(authDate) || authDate <= 0) return null;
  const nowSeconds = nowMs / 1000;
  if (nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > FUTURE_SKEW_SECONDS) return null;

  values.delete("hash");
  // Byte-wise (not locale-aware) ordering, as required by the spec.
  const checkString = [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = createHmac("sha256", secret).update(checkString).digest();
  const supplied = Buffer.from(suppliedHash, "hex");
  if (supplied.length !== calculated.length || !timingSafeEqual(calculated, supplied)) return null;
  try {
    // Rebuilt field by field: extra or wrongly typed properties never reach SQLite or /api/me.
    const parsed = JSON.parse(userJson) as Record<string, unknown> | null;
    const id = parsed?.id; const firstName = parsed?.first_name;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof firstName !== "string") return null;
    const user: TelegramUser = { id, first_name: firstName };
    if (typeof parsed?.last_name === "string") user.last_name = parsed.last_name;
    if (typeof parsed?.username === "string") user.username = parsed.username;
    return user;
  } catch { return null; }
}

/** Secret sent by Telegram in X-Telegram-Bot-Api-Secret-Token; derived from the bot token unless configured. */
export function deriveWebhookSecret(botToken: string): string {
  // Without a token the digest is a public constant anyone can recompute — never derive one.
  if (!botToken) throw new Error("Cannot derive the webhook secret without a bot token");
  return createHash("sha256").update(`orar-webhook:${botToken}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export async function telegramApi(token: string, method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  await telegramApiResponse(token, method, payload, signal);
}

export async function telegramApiResponse<T>(token: string, method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (!token) throw new Error("Telegram token is not configured");
  // Long polling uses `timeout` seconds; always leave a margin so a dead connection cannot hang forever.
  const timeoutMs = (typeof payload.timeout === "number" ? payload.timeout : 0) * 1000 + 15_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  const data = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } | null;
  if (!response.ok || !data?.ok) {
    const description = typeof data?.description === "string" ? `: ${data.description.slice(0, 200)}` : "";
    throw new TelegramApiError(`Telegram ${method} failed (${response.status})${description}`, response.status, data?.parameters?.retry_after);
  }
  return data.result as T;
}
