/**
 * Who a sign-in session belongs to, as app_web for that session (core.actor_id(), migration 0001:
 * NULL for a missing, unknown, expired or banned session). SERVER-INTERNAL: the web server uses it
 * to refuse requests without a live session, to bind the encrypted birthdate to its user (LLD
 * §5.6 associated data) and to reuse the stored fingerprints. The fingerprints and ciphertext are
 * personal-data derived: never put them in a response, a log or an error.
 */
import type { Pool } from "pg";
import { asWeb } from "./command";

export interface SessionActor {
  userId: string;
  /** Null until the phone is verified (the profile is created then). */
  profile: {
    handle: string | null;
    emailFingerprint: Buffer;
    phoneFingerprint: Buffer | null;
  } | null;
  /** AES-256-GCM ciphertext made by the web server; null until recorded. */
  birthdateEnc: Buffer | null;
}

/** The actor of the session, or null when the session does not sign anyone in. */
export async function sessionActor(
  pool: Pool,
  input: { authSessionId: string },
): Promise<SessionActor | null> {
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{
      user_id: string | null;
      profile_id: string | null;
      handle: string | null;
      email_fingerprint: Buffer | null;
      phone_fingerprint: Buffer | null;
      birthdate_enc: Buffer | null;
    }>(
      `SELECT a.id AS user_id, p.id AS profile_id, p.handle, p.email_fingerprint, p.phone_fingerprint,
              s.birthdate_enc
         FROM (SELECT core.actor_id() AS id) a
         LEFT JOIN core.user_profile p ON p.id = a.id
         LEFT JOIN private.user_secret s ON s.user_id = a.id`,
    );
    const r = rows[0];
    if (!r || r.user_id === null) return null;
    return {
      userId: r.user_id,
      profile:
        r.profile_id === null || r.email_fingerprint === null
          ? null
          : {
              handle: r.handle,
              emailFingerprint: r.email_fingerprint,
              phoneFingerprint: r.phone_fingerprint,
            },
      birthdateEnc: r.birthdate_enc,
    };
  });
}
