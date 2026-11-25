import "./server-only";
import { createHash } from "node:crypto";
import { DomainError } from "@delulu/core";
import { SERVER_CONFIG } from "./config";
import { env } from "./env";
import { rateAllowed } from "./rate-limit";

/**
 * Cloudflare Turnstile, checked on the server (ninth review, major 2a). The browser renders the
 * widget with the PUBLIC site key and sends the token it got with the request; the server checks it
 * against Cloudflare's siteverify endpoint with the SECRET key before anything else happens:
 *  - bound to the ACTION the widget was rendered for (email_start, email_verify, phone_code) and to
 *    this deployment's HOST name (APP_ORIGIN), and no older than tokenMaxAgeSeconds;
 *  - SINGLE USE: Cloudflare refuses a token it validated before, and the server also remembers a
 *    digest of every token presented (core.rate_counter, one hit allowed) so a token cannot be
 *    raced through twice;
 *  - FAIL CLOSED: a timeout, a network error, a 5xx, an unreadable answer: the request is refused.
 * The token is never logged; the secret key never leaves this module except to Cloudflare. The
 * token is NOT forwarded to Supabase (Supabase's own captcha setting must stay off: it would need
 * the same single-use token).
 */
export type ChallengeAction = "email_start" | "email_verify" | "phone_code";

export const CHALLENGE_MESSAGE = "Complete the check below (it may have expired), then try again.";

export interface ChallengeDeps {
  fetch?: typeof fetch;
  nowMs?: () => number;
  /** Marks the token spent; false when it was presented before. Defaults to the database. */
  spend?: (tokenDigest: string) => Promise<boolean>;
}

const TOKEN = /^[A-Za-z0-9._:-]{1,4096}$/;

function refuse(reason: string): never {
  console.error("[captcha] refused", reason);
  throw new DomainError("CAPTCHA_FAILED", CHALLENGE_MESSAGE);
}

/** True when this deployment asks for a challenge (keys configured and CAPTCHA not off). */
export function challengeEnabled(): boolean {
  return env().captcha !== null;
}

/** The public site key for the browser, or null when no challenge is asked for. */
export function challengeSiteKey(): string | null {
  return env().captcha?.siteKey ?? null;
}

/** Throws CAPTCHA_FAILED unless `token` is a fresh, unused Turnstile token for `action` on this host. */
export async function requireChallenge(
  token: unknown,
  action: ChallengeAction,
  deps: ChallengeDeps = {},
): Promise<void> {
  const config = env().captcha;
  if (config === null) return;
  if (typeof token !== "string" || token.length > SERVER_CONFIG.captcha.tokenMaxChars || !TOKEN.test(token)) {
    refuse("MISSING");
  }
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  const spend =
    deps.spend ??
    ((d: string) =>
      rateAllowed(
        {
          scope: "auth.captcha.token",
          by: "token",
          limit: 1,
          windowSeconds: SERVER_CONFIG.captcha.spentWindowSeconds,
        },
        d,
      ));
  let fresh: boolean;
  try {
    fresh = await spend(digest);
  } catch {
    refuse("SPEND_UNAVAILABLE");
  }
  if (!fresh) refuse("REUSED");

  let answer: Record<string, unknown>;
  try {
    // No idempotency_key: Cloudflare accepts only a UUID there and answers bad-request for anything
    // else. One call per token is already guaranteed by the spend check above.
    const body = new URLSearchParams({ secret: config.secretKey, response: token });
    const response = await (deps.fetch ?? fetch)(config.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(SERVER_CONFIG.captcha.timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200 || text.length > SERVER_CONFIG.captcha.maxResponseBytes) {
      refuse(`HTTP_${response.status}`);
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse("UNREADABLE");
    answer = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    refuse("UNAVAILABLE");
  }
  if (answer.success !== true) {
    const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].join(",") : "";
    refuse(`NOT_SUCCESS ${codes.replace(/[^a-z0-9,-]/gi, "").slice(0, 120)}`);
  }
  if (answer.action !== action) refuse("ACTION");
  if (answer.hostname !== new URL(env().appOrigin).hostname) refuse("HOSTNAME");
  const issued = typeof answer.challenge_ts === "string" ? Date.parse(answer.challenge_ts) : Number.NaN;
  const now = (deps.nowMs ?? Date.now)();
  const maxAgeMs = SERVER_CONFIG.captcha.tokenMaxAgeSeconds * 1000;
  if (!Number.isFinite(issued) || now - issued > maxAgeMs || issued - now > 60_000) refuse("STALE");
}
