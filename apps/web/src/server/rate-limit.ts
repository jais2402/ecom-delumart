import "./server-only";
import { DomainError } from "@delulu/core";
import { rateHit } from "@delulu/db/runtime";
import { ipv6NetworkKey, rateAddressKey } from "./client-address";
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
  /**
   * "address": the client address (before authentication); "actor": the signed-in user; "email":
   * a normalised email address, alone or with the client's network (sign-in; enforced by the
   * sign-in routes, never by route()); "phone": an SMS destination number (phone step); "token": a
   * digest of a captcha token (spent once).
   */
  by: "address" | "actor" | "email" | "phone" | "token";
  limit: number;
  windowSeconds: number;
}

export const RATE_RULES = SERVER_CONFIG.rateLimit satisfies Record<string, RateRule>;

/** Seconds until the fixed window containing `nowMs` ends (the database aligns windows the same way). */
export function retryAfterSeconds(windowSeconds: number, nowMs: number = Date.now()): number {
  const windowMs = windowSeconds * 1000;
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}

/**
 * Counts one hit of `rule` for `value` (an address, a user id, an email or a phone number; only a
 * keyed digest of it is stored) and answers whether it is within the limit.
 */
export async function rateAllowed(rule: RateRule, value: string): Promise<boolean> {
  const address = rule.by === "address";
  // an IPv6 client counts by its /64 (sixth review, minor 10); its /48 caps how many new subjects
  // one network may create (ninth review, major 2c)
  const net = address ? ipv6NetworkKey(value) : null;
  return rateHit(webPool(), "app_web", {
    scope: rule.scope,
    subject: rateSubject(rule.by, address ? rateAddressKey(value) : value),
    windowSeconds: rule.windowSeconds,
    maxHits: rule.limit * env().rateLimitMultiplier,
    net: net === null ? null : rateSubject("net", net),
  });
}

/** Counts one hit of `rule` for `value`; RATE_LIMITED beyond the limit. */
export async function enforceRate(rule: RateRule, value: string): Promise<void> {
  if (!(await rateAllowed(rule, value))) {
    throw new DomainError("RATE_LIMITED", "Too many tries. Wait a moment and try again.", {
      retryAfterSeconds: retryAfterSeconds(rule.windowSeconds),
    });
  }
}
