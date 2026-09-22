import type { NextFunction, Request, Response } from "express";

export type RateLimiter = {
  /** Returns the seconds to wait when the key is over the limit (or the limiter is full), or 0 when the hit is allowed. */
  hit(key: string, now?: number): number;
  size(): number;
  prune(now?: number): void;
};

/** Fixed-window, in-memory limiter. Suitable for a single API instance. */
export function createRateLimiter(limit: number, windowMs = 60_000, maxKeys = 50_000): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const prune = (now = Date.now()) => { for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key); };
  return {
    hit(key, now = Date.now()) {
      if (limit <= 0) return 0;
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        if (!bucket && buckets.size >= maxKeys) prune(now);
        // Still full after pruning (only under a flood of distinct keys): reject instead of growing
        // memory without bound. Failing closed keeps the limiter useful exactly when it is attacked.
        if (!bucket && buckets.size >= maxKeys) return Math.max(1, Math.ceil(windowMs / 1000));
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count > limit ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : 0;
    },
    size: () => buckets.size,
    prune
  };
}

export function rateLimitMiddleware(limiter: RateLimiter, keyOf: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const retryAfter = key ? limiter.hit(key) : 0;
    if (!retryAfter) return next();
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Prea multe cereri. Încearcă din nou peste câteva secunde." });
  };
}
