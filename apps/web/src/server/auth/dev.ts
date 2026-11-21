import "../server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeEmail } from "@delulu/core";
import { uuidv7 } from "@delulu/db/runtime";
import pg from "pg";
import { SERVER_CONFIG } from "../config";
import { env } from "../env";
import type { AuthProvider, PhoneCodeResult } from "./types";

/**
 * DEVELOPMENT SIGN-IN PROVIDER: a stand-in for the sign-in service that signs anyone in by email
 * alone and accepts the phone code 000000. Refused at module load unless AUTH_PROVIDER is 'dev'
 * and NODE_ENV is not production, so a production deployment cannot load it.
 *
 * It writes auth.users and auth.sessions (the local stand-in schema of migration 0001) with the
 * owner connection, as the real sign-in service would. The user id is derived from the normalised
 * email with IDENTITY_KEY, so the same email always signs in to the same user. The verified email
 * and the pending phone number are kept in process memory only (the stand-in auth.users has no
 * email column): after a server restart a user who has not verified a phone yet signs in again.
 */
if (process.env.NODE_ENV === "production") {
  throw new Error("The dev sign-in provider is refused in production.");
}
if (process.env.AUTH_PROVIDER !== "dev") {
  throw new Error("The dev sign-in provider is loaded only when AUTH_PROVIDER is 'dev'.");
}

interface DevSessionState {
  /** Null when the state was recreated after a restart (only the phone step needs it then). */
  email: string | null;
  pendingPhone: string | null;
  wrongCodes: number;
}

interface DevState {
  owner: pg.Pool | undefined;
  sessions: Map<string, DevSessionState>;
}

// globalThis: Next.js may evaluate this module once per route bundle in development.
const STATE_KEY = Symbol.for("delulumart.dev-auth");
const holder = globalThis as unknown as Record<symbol, DevState | undefined>;
holder[STATE_KEY] ??= { owner: undefined, sessions: new Map() };
const state = holder[STATE_KEY] as DevState;

function ownerPool(): pg.Pool {
  const url = env().databaseUrlOwner;
  if (!url) throw new Error("DATABASE_URL_OWNER is required by the dev sign-in provider.");
  if (!state.owner) {
    state.owner = new pg.Pool({ connectionString: url, max: SERVER_CONFIG.pools.ownerMax });
    state.owner.on("error", (error: Error & { code?: string }) => {
      console.error("[db:dev-auth] idle connection error", error.code ?? error.name);
    });
  }
  return state.owner;
}

/** Process memory is keyed by a hash of the session id, never the id itself. */
const keyOf = (sessionId: string) => createHash("sha256").update(sessionId).digest("base64url");

/** A stable user id for an email: HMAC(IDENTITY_KEY, …) laid out as an RFC 9562 version 8 uuid. */
export function devUserId(identityKey: Uint8Array, normalizedEmail: string): string {
  const bytes = createHmac("sha256", identityKey).update(`dev-auth-user|${normalizedEmail}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const provider: AuthProvider = {
  kind: "dev",

  async beginSignIn(email) {
    normalizeEmail(email); // VALIDATION_FAILED for a malformed address
    return { next: "complete-dev-sign-in" };
  },

  async completeDevSignIn(email) {
    const normalized = normalizeEmail(email);
    const userId = devUserId(env().identityKey, normalized);
    const sessionId = uuidv7();
    const client = await ownerPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
      await client.query(
        "INSERT INTO auth.sessions (id, user_id, not_after) VALUES ($1, $2, now() + make_interval(secs => $3))",
        [sessionId, userId, SERVER_CONFIG.session.ttlSeconds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    state.sessions.set(keyOf(sessionId), { email: normalized, pendingPhone: null, wrongCodes: 0 });
    return { sessionId, userId };
  },

  async signOut(sessionId) {
    state.sessions.delete(keyOf(sessionId));
    await ownerPool().query("DELETE FROM auth.sessions WHERE id = $1", [sessionId]);
  },

  async verifiedEmail(sessionId) {
    return state.sessions.get(keyOf(sessionId))?.email ?? null;
  },

  async sendPhoneCode(sessionId, e164) {
    const key = keyOf(sessionId);
    const s = state.sessions.get(key) ?? { email: null, pendingPhone: null, wrongCodes: 0 };
    s.pendingPhone = e164;
    s.wrongCodes = 0;
    state.sessions.set(key, s);
    return { devCode: SERVER_CONFIG.phone.devCode };
  },

  async verifyPhoneCode(sessionId, code): Promise<PhoneCodeResult> {
    const s = state.sessions.get(keyOf(sessionId));
    if (!s?.pendingPhone) return { ok: false, reason: "NO_CODE_REQUESTED" };
    if (sameCode(code, SERVER_CONFIG.phone.devCode)) {
      const e164 = s.pendingPhone;
      s.pendingPhone = null;
      s.wrongCodes = 0;
      return { ok: true, e164 };
    }
    s.wrongCodes += 1;
    if (s.wrongCodes >= SERVER_CONFIG.phone.maxWrongCodes) {
      s.pendingPhone = null;
      s.wrongCodes = 0;
      return { ok: false, reason: "TOO_MANY_TRIES" };
    }
    return { ok: false, reason: "WRONG_CODE" };
  },
};

export function devAuthProvider(): AuthProvider {
  return provider;
}

/** Tests: end the owner pool and forget the in-memory session state. */
export async function closeDevAuth(): Promise<void> {
  const pool = state.owner;
  state.owner = undefined;
  state.sessions.clear();
  await pool?.end();
}
