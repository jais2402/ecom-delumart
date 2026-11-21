import type { Pool } from "pg";
import { asPay } from "./command";

/** Seeded by migration 0013. */
export const MINT_ACCOUNT_ID = "00000000-0000-7000-8000-000000000001";
export const SINK_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

/**
 * The STARTER grant: ₹100 crore in paise. Fixed by the product rules, enforced by the
 * database (ledger.starter_grant_paise, migration 0016), and deliberately not read from
 * core.config_version, so that no configuration row can change what a new account gets.
 */
export const STARTER_GRANT_PAISE = 100_000_000_000n;

export interface ProvisionInput {
  /** The caller's sign-in session (auth.sessions id); the database derives the user from it. */
  authSessionId: string;
  /** HMAC of the normalised email (LLD §5.6). */
  emailFingerprint: Buffer;
  /** HMAC of the verified E.164 number; null if not yet verified. */
  phoneFingerprint: Buffer | null;
  /** 16-digit display number from the card-number algorithm (LLD §5.4). */
  cardNumber: string;
  alias: string;
  upiStyleId: string;
}

export interface ProvisionResult {
  /** false when the account already existed and the stored records were returned. */
  created: boolean;
  userId: string;
  ledgerAccountId: string;
  bankAccountId: string;
  cardId: string;
  cardNumber: string;
  walletPaise: bigint;
  starterJournalId: string | null;
  grantRecordId: string | null;
}

interface StoredProvision {
  created: boolean;
  userId: string;
  ledgerAccountId: string;
  bankAccountId: string;
  cardId: string;
  cardNumber: string;
  walletPaise: string;
  starterJournalId: string | null;
  grantRecordId: string | null;
}

/**
 * LLD §7.1 provisioning, one transaction, through core.provision_account (migration 0018), the
 * only way a profile is created: profile for the signed-in user (if absent), ledger account,
 * bank account, wallet, STARTER grant journal, grant record, one ACTIVE card. The grant is
 * skipped when the stored email or phone fingerprint matches an unexpired identity tombstone.
 * Concurrent and repeated calls return the existing records; the grant is never repeated
 * (US-01, US-14). Runs as the money-command role app_pay.
 */
export async function provisionAccount(pool: Pool, input: ProvisionInput): Promise<ProvisionResult> {
  const stored = await asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ r: StoredProvision }>(
      "SELECT core.provision_account($1, $2, $3, $4, $5) AS r",
      [input.emailFingerprint, input.phoneFingerprint, input.cardNumber, input.alias, input.upiStyleId],
    );
    const r = rows[0]?.r;
    if (!r) throw new Error("provision_account returned nothing");
    return r;
  });
  return { ...stored, walletPaise: BigInt(stored.walletPaise) };
}
