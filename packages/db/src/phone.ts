/**
 * Phone-code bookkeeping for the 'sms' mode (ninth review, major 1; migration 0075). Only keyed
 * fingerprints of numbers are stored. `authPhoneHolder` is the one call that passes a number (the
 * sign-in service stores numbers in plain text in auth.users, so it is compared there); the
 * database neither stores nor returns it, and the holder's id it answers stays on the server.
 */
import type { Pool, PoolClient } from "pg";
import { asWeb, mapCommandError, requireUuid } from "./command";
import { withTransaction } from "./transaction";

function requireFingerprint(value: Uint8Array): Buffer {
  const b = Buffer.from(value);
  if (b.length !== 32) throw new Error("a phone fingerprint is 32 bytes");
  return b;
}

export type PhoneNumberAttempt = "KNOWN" | "NEW" | "LIMIT";

/** Records that the actor asks for a code to this number; LIMIT when too many distinct numbers. */
export async function phoneNumberAttempt(
  pool: Pool,
  input: { authSessionId: string; phoneFingerprint: Uint8Array },
): Promise<PhoneNumberAttempt> {
  const fp = requireFingerprint(input.phoneFingerprint);
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ r: string }>("SELECT core.phone_number_attempt($1) AS r", [fp]);
    const r = rows[0]?.r;
    return r === "KNOWN" || r === "NEW" ? r : "LIMIT";
  });
}

/** The server set this (unconfirmed) number on the actor's sign-in user. */
export async function phoneHoldSet(
  pool: Pool,
  input: { authSessionId: string; phoneFingerprint: Uint8Array },
): Promise<void> {
  const fp = requireFingerprint(input.phoneFingerprint);
  await asWeb(pool, input.authSessionId, async (c) => {
    await c.query("SELECT core.phone_hold_set($1)", [fp]);
  });
}

/**
 * The sign-in user holding `phoneDigits` (E.164 without '+') when that holder's number is
 * unconfirmed and older than the code lifetime; null otherwise (a confirmed holder is never named).
 * SERVER-ONLY: the id must never reach a client, a log or an error.
 */
export async function authPhoneHolder(
  pool: Pool,
  input: { authSessionId: string; phoneDigits: string; phoneFingerprint: Uint8Array },
): Promise<string | null> {
  const fp = requireFingerprint(input.phoneFingerprint);
  if (!/^\d{6,15}$/.test(input.phoneDigits)) return null;
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ id: string | null }>("SELECT core.auth_phone_holder($1, $2) AS id", [
      input.phoneDigits,
      fp,
    ]);
    return rows[0]?.id ?? null;
  });
}

async function asJobs<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(pool, fn, { role: "app_jobs", lockTimeout: "2s", statementTimeout: "30s" });
  } catch (error) {
    throw mapCommandError(error);
  }
}

export interface ExpiredPhoneHold {
  userId: string;
  phoneFingerprint: Buffer;
}

/** The job runner: holds older than the code lifetime, oldest first. */
export async function expiredPhoneHolds(pool: Pool, limit: number): Promise<ExpiredPhoneHold[]> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ user_id: string; phone_fp: Buffer }>(
      "SELECT user_id, phone_fp FROM core.phone_holds_expired($1)",
      [limit],
    );
    return rows.map((r) => ({ userId: r.user_id, phoneFingerprint: r.phone_fp }));
  });
}

/** The job runner is done with this hold (released, or nothing to release). */
export async function phoneHoldDone(pool: Pool, hold: ExpiredPhoneHold): Promise<void> {
  requireUuid(hold.userId, "userId");
  await asJobs(pool, async (c) => {
    await c.query("SELECT core.phone_hold_done($1, $2)", [hold.userId, hold.phoneFingerprint]);
  });
}
