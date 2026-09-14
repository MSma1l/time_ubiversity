import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, miniAppButton } from "./config.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

describe("loadConfig", () => {
  it("applies defaults for local development", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 3001, databasePath: "./data/orar.sqlite", allowDevAuth: false, polling: false, origins: [], rateLimitPerMinute: 120 });
  });
  it("fails fast in production without a bot token or with dev auth", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: TOKEN, ALLOW_DEV_AUTH: "true" })).toThrow(/ALLOW_DEV_AUTH/);
    expect(loadConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: TOKEN }).production).toBe(true);
  });
  it("validates numbers, urls and parses lists", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ WEBHOOK_URL: "http://insecure" })).toThrow(/WEBHOOK_URL/);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "nope" })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(loadConfig({ ALLOWED_ORIGINS: " https://a.md/ , https://b.md,," }).origins).toEqual(["https://a.md", "https://b.md"]);
    expect(loadConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
  });
  it("only adds Mini App buttons for https urls", () => {
    expect(miniAppButton({ miniAppUrl: "http://localhost:5173" }, "Open")).toBeUndefined();
    expect(miniAppButton({ miniAppUrl: "https://orar.md" }, "Open")).toEqual({ inline_keyboard: [[{ text: "Open", web_app: { url: "https://orar.md" } }]] });
  });
});
