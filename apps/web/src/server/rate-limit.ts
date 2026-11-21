import "./server-only";
import { DomainError } from "@delulu/core";
import { rateHit } from "@delulu/db/runtime";
import { SERVER_CONFIG } from "./config";
import { rateSubject } from "./crypto";
import { webPool } from "./db";
import { env } from "./env";

/**
 * Rate limits kept in the database (LLD §11.2; fifth security review): they survive restarts, are
 * shared by every server instance and cannot be reset by signing in again. Each hit is committed
 * in its own short transaction BEFORE the business call, so a call that then fails and rolls back
 * still counts.
 */
export interface RateRule {
  /** The counter's name in core.rate_counter. */
  scope: string;
  /** "address": the client address (before authentication); "actor": the signed-in user. */
  by: "address" | "actor";
  limit: number;
  windowSeconds: number;
}

export const RATE_RULES = SERVER_CONFIG.rateLimit satisfies Record<string, RateRule>;

/** Seconds until the fixed window containing `nowMs` ends (the database aligns windows the same way). */
export function retryAfterSeconds(windowSeconds: number, nowMs: number = Date.now()): number {
  const windowMs = windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

/** Counts one hit of `rule` for `value` (an address or a user id); RATE_LIMITED beyond the limit. */
export async function enforceRate(rule: RateRule, value: string): Promise<void> {
  const allowed = await rateHit(webPool(), "app_web", {
    scope: rule.scope,
    subject: rateSubject(rule.by, value),
    windowSeconds: rule.windowSeconds,
    maxHits: rule.limit * env().rateLimitMultiplier,
  });
  if (!allowed) {
    throw new DomainError("RATE_LIMITED", "Too many tries. Wait a moment and try again.", {
      retryAfterSeconds: retryAfterSeconds(rule.windowSeconds),
    });
  }
}
