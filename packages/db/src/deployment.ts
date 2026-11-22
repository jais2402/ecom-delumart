/**
 * Deployment facts and session ending (migrations 0070-0072), on the web role app_web.
 *
 *  - phoneVerificationMode: 'sms' or 'unverified', an OWNER decision stored in
 *    core.deployment_setting; the web server only reads it.
 *  - endSession: signs the caller's sign-in session out for good (core.end_session()).
 *  - adminHealth: deployment facts for the Super Admin only (FORBIDDEN otherwise).
 */
import type { Pool } from "pg";
import { asWeb, requireUuid } from "./command";

export type PhoneVerificationMode = "sms" | "unverified";

export async function phoneVerificationMode(pool: Pool): Promise<PhoneVerificationMode> {
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<{ mode: string }>("SELECT core.phone_verification_mode() AS mode");
    // anything unexpected is treated as the strict mode
    return rows[0]?.mode === "unverified" ? "unverified" : "sms";
  });
}

/**
 * Records that the web server accepted this sign-in session for this user (migration 0074), AFTER
 * it verified the sign-in service's access token. The database re-checks the session itself (it
 * exists, belongs to the user, is live, the user is not anonymous, banned or deleted). False when
 * it refuses; only a registered session signs anyone in (core.actor_id()).
 */
export async function registerAppSession(
  pool: Pool,
  input: { authSessionId: string; userId: string },
): Promise<boolean> {
  requireUuid(input.authSessionId, "authSessionId");
  requireUuid(input.userId, "userId");
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>("SELECT core.register_app_session($1, $2) AS ok", [
      input.authSessionId,
      input.userId,
    ]);
    return rows[0]?.ok === true;
  });
}

/** Ends the caller's session (idempotent; an unknown id does nothing). */
export async function endSession(pool: Pool, input: { authSessionId: string }): Promise<void> {
  requireUuid(input.authSessionId, "authSessionId");
  await asWeb(pool, input.authSessionId, async (c) => {
    await c.query("SELECT core.end_session()");
  });
}

export interface AdminHealth {
  migrationVersion: string | null;
  phoneVerification: PhoneVerificationMode;
  sessionMaxAgeSeconds: number;
  /** ISO time (UTC, to the second) of the last job run the database accepted; null if never. */
  jobsLastRunAt: string | null;
  jobsRuns: number | null;
}

export async function adminHealth(pool: Pool, input: { authSessionId: string }): Promise<AdminHealth> {
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ r: AdminHealth }>("SELECT core.admin_health() AS r");
    const r = rows[0]?.r;
    if (!r) throw new Error("admin_health returned nothing");
    return {
      migrationVersion: r.migrationVersion ?? null,
      phoneVerification: r.phoneVerification === "unverified" ? "unverified" : "sms",
      sessionMaxAgeSeconds: Number(r.sessionMaxAgeSeconds),
      jobsLastRunAt: r.jobsLastRunAt ?? null,
      jobsRuns: r.jobsRuns === null || r.jobsRuns === undefined ? null : Number(r.jobsRuns),
    };
  });
}
