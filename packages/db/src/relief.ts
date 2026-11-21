/**
 * The relief grant (migration 0033). The status is a read as app_web; the claim is a money command
 * run as app_pay. The database derives the actor from the sign-in session, checks eligibility
 * under the wallet lock, and posts the RELIEF_GRANT journal; every amount is a database constant.
 */
import type { Pool } from "pg";
import { asPay, asWeb, one, requireUuid } from "./command";

export type ReliefReason = "LIFETIME_LIMIT" | "CLAIMED_TODAY" | "BALANCE_TOO_HIGH";

export interface ReliefStatus {
  eligible: boolean;
  reason: ReliefReason | null;
  claimsUsed: number;
  claimsMax: number;
  claimsRemaining: number;
  balancePaise: bigint | null;
  ceilingPaise: bigint;
  grantPaise: bigint;
  /** The next UTC midnight: when a claim made today stops counting as today's. */
  nextResetAt: Date;
}

export interface ReliefClaim extends ReliefStatus {
  productId: string;
  grantedPaise: bigint;
}

interface StoredStatus {
  eligible: boolean;
  reason: ReliefReason | null;
  claimsUsed: number;
  claimsMax: number;
  claimsRemaining: number;
  balancePaise: string | null;
  ceilingPaise: string;
  grantPaise: string;
  nextResetAt: string;
}

function statusOf(s: StoredStatus): ReliefStatus {
  return {
    eligible: s.eligible,
    reason: s.reason,
    claimsUsed: s.claimsUsed,
    claimsMax: s.claimsMax,
    claimsRemaining: s.claimsRemaining,
    balancePaise: s.balancePaise === null ? null : BigInt(s.balancePaise),
    ceilingPaise: BigInt(s.ceilingPaise),
    grantPaise: BigInt(s.grantPaise),
    nextResetAt: new Date(s.nextResetAt),
  };
}

export async function reliefStatus(pool: Pool, input: { authSessionId: string }): Promise<ReliefStatus> {
  return statusOf(
    await asWeb(pool, input.authSessionId, (c) =>
      one<StoredStatus>(c, "SELECT core.relief_status() AS r", []),
    ),
  );
}

/** Saves a never-saved published product and claims today's relief grant with it. */
export async function claimRelief(
  pool: Pool,
  input: { authSessionId: string; productId: string },
): Promise<ReliefClaim> {
  requireUuid(input.productId, "productId");
  const r = await asPay(pool, input.authSessionId, (c) =>
    one<StoredStatus & { productId: string; grantedPaise: string }>(c, "SELECT core.claim_relief($1) AS r", [
      input.productId,
    ]),
  );
  return { ...statusOf(r), productId: r.productId, grantedPaise: BigInt(r.grantedPaise) };
}
