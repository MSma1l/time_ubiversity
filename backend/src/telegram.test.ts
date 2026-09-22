import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveWebhookSecret, safeEqual, validateInitData } from "./telegram.js";

const TOKEN = "123456:TEST-token_abcdefghijklmnopqrstuvwxyz";
const NOW = Date.UTC(2026, 8, 14, 10, 0, 0);

function sign(fields: Record<string, string>, token = TOKEN) {
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 987654321, first_name: "Ion", last_name: "Popescu", username: "ion" });
const base = { auth_date: String(NOW / 1000 - 60), query_id: "AAE123", user, signature: "sig" };

describe("validateInitData", () => {
  it("accepts correctly signed, fresh data", () => {
    expect(validateInitData(sign(base), TOKEN, 86_400, NOW)).toMatchObject({ id: 987654321, first_name: "Ion" });
  });
  it("rejects a tampered field", () => {
    const tampered = sign(base).replace("Ion", "Ana");
    expect(validateInitData(tampered, TOKEN, 86_400, NOW)).toBeNull();
  });
  it("rejects data signed with another bot token", () => {
    expect(validateInitData(sign(base, "999:other-token-abcdefghijklmnopqrstuv"), TOKEN, 86_400, NOW)).toBeNull();
  });
  it("rejects expired and far-future auth_date", () => {
    expect(validateInitData(sign({ ...base, auth_date: String(NOW / 1000 - 90_000) }), TOKEN, 86_400, NOW)).toBeNull();
    expect(validateInitData(sign({ ...base, auth_date: String(NOW / 1000 + 3_600) }), TOKEN, 86_400, NOW)).toBeNull();
    expect(validateInitData(sign({ ...base, auth_date: String(NOW / 1000 + 30) }), TOKEN, 86_400, NOW)).not.toBeNull();
  });
  it("rejects missing hash, malformed hash, missing user or empty token", () => {
    const params = new URLSearchParams(sign(base));
    params.delete("hash");
    expect(validateInitData(params.toString(), TOKEN, 86_400, NOW)).toBeNull();
    params.set("hash", "zz");
    expect(validateInitData(params.toString(), TOKEN, 86_400, NOW)).toBeNull();
    expect(validateInitData(sign({ auth_date: base.auth_date }), TOKEN, 86_400, NOW)).toBeNull();
    expect(validateInitData(sign(base), "", 86_400, NOW)).toBeNull();
    expect(validateInitData("", TOKEN, 86_400, NOW)).toBeNull();
  });
  it("rejects a signed user object without a valid id", () => {
    expect(validateInitData(sign({ ...base, user: JSON.stringify({ id: "1", first_name: "X" }) }), TOKEN, 86_400, NOW)).toBeNull();
    expect(validateInitData(sign({ ...base, user: "not json" }), TOKEN, 86_400, NOW)).toBeNull();
  });
  it("defaults to a one-hour replay window", () => {
    expect(validateInitData(sign({ ...base, auth_date: String(NOW / 1000 - 1_800) }), TOKEN, undefined, NOW)).not.toBeNull();
    expect(validateInitData(sign({ ...base, auth_date: String(NOW / 1000 - 7_200) }), TOKEN, undefined, NOW)).toBeNull();
  });
  it("rejects initData with duplicate keys even when the hash covers them all", () => {
    const evil = JSON.stringify({ id: 1, first_name: "Evil" });
    const fields: [string, string][] = [["auth_date", base.auth_date], ["user", evil], ["user", user]];
    const checkString = [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const params = new URLSearchParams(fields);
    params.append("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
    expect(validateInitData(params.toString(), TOKEN, 3_600, NOW)).toBeNull();
    // Control: the very same signing scheme without the duplicate is accepted.
    const single = new URLSearchParams([["auth_date", base.auth_date], ["user", user]] as [string, string][]);
    single.append("hash", createHmac("sha256", secret).update(`auth_date=${base.auth_date}\nuser=${user}`).digest("hex"));
    expect(validateInitData(single.toString(), TOKEN, 3_600, NOW)).not.toBeNull();
  });
  it("returns only the whitelisted user fields, with the right types", () => {
    const messy = JSON.stringify({ id: 5, first_name: "Ana", last_name: 7, username: "ana", is_premium: true, photo_url: "x" });
    expect(validateInitData(sign({ ...base, user: messy }), TOKEN, 3_600, NOW)).toEqual({ id: 5, first_name: "Ana", username: "ana" });
  });
});

describe("webhook secret", () => {
  it("is deterministic, Telegram-compatible and compared safely", () => {
    const secret = deriveWebhookSecret(TOKEN);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveWebhookSecret(TOKEN)).toBe(secret);
    expect(safeEqual(secret, secret)).toBe(true);
    expect(safeEqual(secret, secret.slice(1))).toBe(false);
    expect(safeEqual("", secret)).toBe(false);
  });
  it("refuses to derive a secret from an empty token", () => {
    expect(() => deriveWebhookSecret("")).toThrow(/bot token/);
  });
});
