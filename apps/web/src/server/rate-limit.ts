import "./server-only";
import { createHash } from "node:crypto";
import { SERVER_CONFIG } from "./config";

/**
 * In-memory fixed-window counters for the dev sign-in and PIN routes.
 *
 * PRODUCTION NEEDS A SHARED STORE: this map lives in one server process, so several instances
 * (or a restart) each get a fresh budget. LLD §11.2 keeps these counters in Postgres; the database
 * also enforces the PIN attempt and lockout limits itself (migration 0025), which this does not
 * replace.
 */
export interface RateLimit {
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Time until the current window ends. */
  retryAfterMs: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly rule: RateLimit,
    private readonly now: () => number = Date.now,
    private readonly sweepAbove: number = SERVER_CONFIG.rateLimit.sweepAbove,
  ) {}

  get size(): number {
    return this.windows.size;
  }

  hit(key: string): RateDecision {
    const now = this.now();
    if (this.windows.size > this.sweepAbove) this.sweep(now);
    const start = now - (now % this.rule.windowMs);
    const current = this.windows.get(key);
    const window = current && current.start === start ? current : { start, count: 0 };
    window.count += 1;
    this.windows.set(key, window);
    return { allowed: window.count <= this.rule.limit, retryAfterMs: start + this.rule.windowMs - now };
  }

  reset(): void {
    this.windows.clear();
  }

  private sweep(now: number): void {
    for (const [key, w] of this.windows) if (w.start + this.rule.windowMs <= now) this.windows.delete(key);
  }
}

/** Keys are hashed so no session id is held as a map key in clear. */
export function limiterKey(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(value).digest("base64url")}`;
}

export const LIMITERS = {
  devSignIn: new FixedWindowLimiter(SERVER_CONFIG.rateLimit.devSignIn),
  pin: new FixedWindowLimiter(SERVER_CONFIG.rateLimit.pin),
  phoneCode: new FixedWindowLimiter(SERVER_CONFIG.rateLimit.phoneCode),
} as const;

export function resetRateLimits(): void {
  for (const limiter of Object.values(LIMITERS)) limiter.reset();
}
