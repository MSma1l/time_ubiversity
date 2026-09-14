import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit.js";

describe("createRateLimiter", () => {
  it("allows up to the limit per window, then reports retry-after", () => {
    const limiter = createRateLimiter(2, 60_000);
    expect(limiter.hit("a", 0)).toBe(0);
    expect(limiter.hit("a", 1_000)).toBe(0);
    expect(limiter.hit("a", 2_000)).toBe(58);
    expect(limiter.hit("b", 2_000)).toBe(0);
    expect(limiter.hit("a", 60_000)).toBe(0);
  });
  it("is disabled with limit 0 and prunes expired keys", () => {
    expect(createRateLimiter(0).hit("a")).toBe(0);
    const limiter = createRateLimiter(5, 1_000, 2);
    limiter.hit("a", 0); limiter.hit("b", 0);
    limiter.hit("c", 2_000);
    expect(limiter.size()).toBe(1);
  });
});
