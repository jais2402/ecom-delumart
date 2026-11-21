import type { Pool } from "pg";
import { mapCommandError } from "./command";
import { type AppRole, withTransaction } from "./transaction";

/**
 * Database fixed-window rate limits (LLD §11.2, migration 0031). `subject` is a 32-byte digest the
 * caller computed (an HMAC of a client address or a user id): no raw address or id is stored.
 */
export interface RateHitInput {
  scope: string;
  subject: Uint8Array;
  windowSeconds: number;
  maxHits: number;
}

/**
 * Counts one hit and answers whether it is within the limit. It runs in its OWN short transaction
 * on its own pooled connection and commits at once, so call it BEFORE the business call: the hit
 * stays counted when the business transaction rolls back.
 */
export async function rateHit(
  pool: Pool,
  role: Extract<AppRole, "app_web" | "app_pay">,
  input: RateHitInput,
): Promise<boolean> {
  try {
    return await withTransaction(
      pool,
      async (c) => {
        const { rows } = await c.query<{ ok: boolean }>("SELECT core.rate_hit($1, $2, $3, $4) AS ok", [
          input.scope,
          Buffer.from(input.subject),
          input.windowSeconds,
          input.maxHits,
        ]);
        return rows[0]?.ok === true;
      },
      { role },
    );
  } catch (error) {
    throw mapCommandError(error);
  }
}
