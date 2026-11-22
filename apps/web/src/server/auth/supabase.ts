import "../server-only";
import { DomainError, normalizePhone } from "@delulu/core";
import { endSession, sessionActor } from "@delulu/db/runtime";
import { SERVER_CONFIG } from "../config";
import { derivedKeyWith } from "../crypto";
import { webPool } from "../db";
import { env } from "../env";
import { JwksCache } from "./jwks";
import { verifyAccessToken } from "./jwt";
import { type SupabaseApi, type SupabaseSession, SupabaseUnavailable, supabaseApi } from "./supabase-api";
import type { AuthProvider, PhoneCodeResult } from "./types";

/**
 * SUPABASE SIGN-IN PROVIDER (server-only). Email link / code and Google through Supabase Auth with
 * PKCE; the code is exchanged here, on the server, in the callback route.
 *
 * TOKENS. Supabase answers a successful sign-in with an access token and a refresh token. The
 * access token is verified here (ES256 against the project's JWKS, iss, aud, exp/nbf, role) only
 * to learn the user id and the sign-in session id; then BOTH TOKENS ARE DROPPED. They are never
 * stored, put in a cookie, a response body or a log. The browser gets only the existing opaque
 * session cookie holding the auth.sessions id, and the database (core.actor_id()) decides on every
 * call whether that session still signs anyone in: live in auth.sessions, user not banned or
 * deleted, younger than core.session_max_age_seconds() and not ended by sign-out (0071).
 *
 * Why no refresh token: nothing here needs a Supabase access token after sign-in (the database is
 * the authority, and the admin endpoints use the secret key), and Supabase does not end a session
 * row when its access token expires unrefreshed. Keeping no refresh token means there is no
 * long-lived Supabase credential to steal from this server or its database.
 *
 * SIGN-OUT records the session as ended in the database (core.end_session(), 0071): Supabase's own
 * logout endpoint needs the session's access token, which is not kept.
 *
 * PHONE (mode 'sms'): the number is set on the Supabase user with the admin API (secret key), an
 * SMS code is sent with /otp (create_user false), and the typed code is checked with /verify type
 * sms, which sets auth.users.phone_confirmed_at (required by the database in 'sms' mode, 0070).
 * That verification returns a NEW Supabase session, which is logged out at once with its own
 * access token. A number that belongs to another Supabase user is answered exactly like a sent
 * code (no SMS goes out, the code then never matches), so the answer does not reveal it.
 */
interface State {
  jwks: JwksCache | undefined;
  jwksUrl: string | undefined;
}
const STATE_KEY = Symbol.for("delulumart.supabase-auth");
const holder = globalThis as unknown as Record<symbol, State | undefined>;
holder[STATE_KEY] ??= { jwks: undefined, jwksUrl: undefined };
const state = holder[STATE_KEY] as State;

function config(): { url: string; publishableKey: string; secretKey: string } {
  const supabase = env().supabase;
  if (supabase === null) throw new Error("Supabase is not configured (AUTH_PROVIDER, SUPABASE_*).");
  return supabase;
}

export function api(): SupabaseApi {
  return supabaseApi({
    ...config(),
    timeoutMs: SERVER_CONFIG.auth.httpTimeoutMs,
    maxBytes: SERVER_CONFIG.auth.maxResponseBytes,
  });
}

function jwks(): JwksCache {
  const url = `${config().url}/auth/v1/.well-known/jwks.json`;
  if (state.jwks === undefined || state.jwksUrl !== url) {
    state.jwks = new JwksCache({
      url,
      ttlMs: SERVER_CONFIG.auth.jwksTtlMs,
      minRefetchMs: SERVER_CONFIG.auth.jwksMinRefetchMs,
      timeoutMs: SERVER_CONFIG.auth.httpTimeoutMs,
      maxBytes: SERVER_CONFIG.auth.maxResponseBytes,
    });
    state.jwksUrl = url;
  }
  return state.jwks;
}

/** Tests: forget the cached signing keys. */
export function resetSupabaseAuthState(): void {
  state.jwks = undefined;
  state.jwksUrl = undefined;
}

/** The key that seals the sign-in flow cookie (derived from IDENTITY_KEY). */
export function flowKey(): Buffer {
  return derivedKeyWith(env().identityKey, "auth-flow");
}

/** The key of the flow's email binding (derived from IDENTITY_KEY, separate purpose). */
export function flowEmailKey(): Buffer {
  return derivedKeyWith(env().identityKey, "auth-flow-email");
}

/** Where Supabase sends the browser back to: the callback, with the flow's state in the path. */
export function callbackUrl(appOrigin: string, flowState: string): string {
  return `${appOrigin}/api/v1/auth/callback/${flowState}`;
}

export type SignInRefusal = "TOKEN" | "USER" | "SESSION";

/** A sign-in that must not proceed; the reason is logged, never shown. */
export class SignInRefused extends Error {
  constructor(readonly reason: SignInRefusal) {
    super("sign-in refused");
    this.name = "SignInRefused";
  }
}

/** Supabase is down or slow: retryable, never a fault message. */
function unavailable(error: unknown): never {
  if (error instanceof SupabaseUnavailable) {
    console.error("[auth] Supabase Auth unavailable", error.status ?? "network");
    throw new DomainError("BUSY", "Sign-in is not available right now. Try again in a minute.");
  }
  throw error;
}

/**
 * From a session Supabase just issued to the sign-in session id the cookie will hold: the token is
 * verified, the user must match, and the DATABASE must see the session as live for that user.
 */
export async function acceptSession(
  session: SupabaseSession,
): Promise<{ sessionId: string; userId: string }> {
  const { url } = config();
  const verified = await verifyAccessToken(session.accessToken, {
    jwks: jwks(),
    issuer: `${url}/auth/v1`,
    audience: "authenticated",
    nowMs: Date.now(),
    skewSeconds: SERVER_CONFIG.auth.clockSkewSeconds,
    maxBytes: SERVER_CONFIG.auth.maxTokenBytes,
  });
  if (!verified.ok) {
    console.error("[auth] access token refused", verified.reason);
    throw new SignInRefused("TOKEN");
  }
  const { sub, sessionId } = verified.claims;
  if (session.userId !== null && session.userId.toLowerCase() !== sub) {
    console.error("[auth] access token refused", "USER_MISMATCH");
    throw new SignInRefused("USER");
  }
  const actor = await sessionActor(webPool(), { authSessionId: sessionId });
  if (actor === null || actor.userId !== sub) {
    // the token is valid, but the database does not see the session (auth.* not readable by the
    // owner of core.actor_id(), the user banned or deleted, or the session already ended)
    console.error("[auth] session not live in the database");
    throw new SignInRefused("SESSION");
  }
  return { sessionId, userId: sub };
}

export const supabaseSignIn = {
  /**
   * Sends the sign-in email (link and code). The answer never says whether the address has an
   * account; Supabase's own rate limit (429) is RATE_LIMITED, any other refusal is logged by
   * status only and answered like a sent email.
   */
  async startEmail(email: string, input: { codeChallenge: string; redirectTo: string }): Promise<void> {
    let result: Awaited<ReturnType<SupabaseApi["sendEmailOtp"]>>;
    try {
      result = await api().sendEmailOtp(email, input);
    } catch (error) {
      unavailable(error);
    }
    if (result.status === 429) {
      throw new DomainError("RATE_LIMITED", "Too many sign-in emails. Wait a few minutes and try again.", {
        retryAfterSeconds: 60,
      });
    }
    if (result.status !== 200) console.error("[auth] sign-in email not sent", result.status);
  },

  googleUrl(input: { codeChallenge: string; redirectTo: string }): string {
    return api().authorizeUrl("google", input);
  },

  async exchange(code: string, verifier: string): Promise<{ sessionId: string; userId: string } | null> {
    let session: SupabaseSession | null;
    try {
      session = await api().exchangeCode(code, verifier);
    } catch (error) {
      unavailable(error);
    }
    return session === null ? null : acceptSession(session);
  },

  async verifyEmailCode(email: string, code: string): Promise<{ sessionId: string; userId: string } | null> {
    let session: SupabaseSession | null;
    try {
      session = await api().verifyEmailCode(email, code);
    } catch (error) {
      unavailable(error);
    }
    return session === null ? null : acceptSession(session);
  },
};

async function actorOf(sessionId: string): Promise<string> {
  const actor = await sessionActor(webPool(), { authSessionId: sessionId });
  if (actor === null) throw new DomainError("AUTH_REQUIRED", "Sign in to continue.");
  return actor.userId;
}

function phoneOf(user: Record<string, unknown>): string | null {
  const phone = user.phone;
  if (typeof phone !== "string" || !/^\+?\d{6,15}$/.test(phone)) return null;
  try {
    return normalizePhone(phone.startsWith("+") ? phone : `+${phone}`);
  } catch {
    return null;
  }
}

const provider: AuthProvider = {
  kind: "supabase",

  async beginSignIn() {
    throw new DomainError("NOT_FOUND", "Not found.");
  },

  async completeDevSignIn() {
    throw new DomainError("NOT_FOUND", "Not found.");
  },

  async signOut(sessionId) {
    await endSession(webPool(), { authSessionId: sessionId });
  },

  async verifiedEmail(sessionId) {
    const userId = await actorOf(sessionId);
    let result: Awaited<ReturnType<SupabaseApi["adminGetUser"]>>;
    try {
      result = await api().adminGetUser(userId);
    } catch (error) {
      unavailable(error);
    }
    if (result.status !== 200) {
      console.error("[auth] user lookup failed", result.status);
      return null;
    }
    const { email, email_confirmed_at: confirmed } = result.json;
    return typeof email === "string" && email.length > 0 && typeof confirmed === "string" ? email : null;
  },

  async sendPhoneCode(sessionId, e164) {
    const userId = await actorOf(sessionId);
    try {
      const set = await api().adminSetPhone(userId, e164);
      if (set.status !== 200) {
        // most likely the number belongs to another user: answered like a sent code
        console.error("[auth] phone not set", set.status);
        return { devCode: null };
      }
      const sent = await api().sendPhoneOtp(e164);
      if (sent.status === 429) {
        throw new DomainError("RATE_LIMITED", "Too many codes. Wait a while and try again.", {
          retryAfterSeconds: 60,
        });
      }
      if (sent.status !== 200) console.error("[auth] phone code not sent", sent.status);
    } catch (error) {
      unavailable(error);
    }
    return { devCode: null };
  },

  async verifyPhoneCode(sessionId, code): Promise<PhoneCodeResult> {
    const userId = await actorOf(sessionId);
    try {
      const user = await api().adminGetUser(userId);
      const e164 = user.status === 200 ? phoneOf(user.json) : null;
      if (e164 === null) return { ok: false, reason: "NO_CODE_REQUESTED" };
      const session = await api().verifyPhoneCode(e164, code);
      if (session === null) return { ok: false, reason: "WRONG_CODE" };
      // the verification signed a NEW Supabase session in: end it now, whatever happens next
      const loggedOut = await api()
        .logout(session.accessToken)
        .catch(() => false);
      if (!loggedOut) console.error("[auth] could not end the phone verification session");
      if (session.userId !== null && session.userId.toLowerCase() !== userId) {
        console.error("[auth] phone verification answered for another user");
        return { ok: false, reason: "WRONG_CODE" };
      }
      return { ok: true, e164 };
    } catch (error) {
      unavailable(error);
    }
  },
};

export function supabaseAuthProvider(): AuthProvider {
  return provider;
}
