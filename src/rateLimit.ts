/**
 * RATE LIMITING — per-user ceilings on the AI endpoints.
 *
 * Auth alone stops strangers; this stops one *authenticated* account (their own,
 * or a stolen token) from running up the Anthropic bill. Two fixed windows:
 *   burst — a short window, catches runaway loops and hammering.
 *   daily — a rolling-day cost ceiling per user.
 *
 * Counters are in-process. That is deliberate: a single small Node host is the
 * deployment target, and the limits are a cost guard, not a security boundary.
 * If this is ever scaled to multiple instances, each gets its own allowance —
 * move the counters to Redis at that point.
 */
import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";

interface Counter {
  count: number;
  /** Epoch ms when this window rolls over. */
  resetAt: number;
}

export interface LimiterOptions {
  /** Shown in logs and in the 429 message. */
  name: string;
  windowMs: number;
  max: number;
}

export function createRateLimiter({ name, windowMs, max }: LimiterOptions) {
  const counters = new Map<string, Counter>();
  let lastSweep = Date.now();

  /** Drop expired counters so an unbounded user set can't grow the map forever. */
  function sweep(now: number) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, c] of counters) {
      if (c.resetAt <= now) counters.delete(key);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    // requireAuth runs first, so req.user is always set here.
    const key = req.user?.id;
    if (!key) return next();

    const now = Date.now();
    sweep(now);

    const current = counters.get(key);
    if (!current || current.resetAt <= now) {
      counters.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      log.info(`rate limit (${name}) hit by user ${key}`);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: {
          code: "rate_limited",
          message: `Too many requests (${name} limit). Retry in ${retryAfterSec}s.`,
        },
      });
    }

    return next();
  };
}
