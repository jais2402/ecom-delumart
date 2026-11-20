import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./transaction";
import { uuidv7 } from "./uuid";

/** Seeded by migration 0013. */
export const MINT_ACCOUNT_ID = "00000000-0000-7000-8000-000000000001";
export const SINK_ACCOUNT_ID = "00000000-0000-7000-8000-000000000002";

export interface ProvisionInput {
  userId: string;
  /** HMAC of the normalised email (LLD §5.6). */
  emailFingerprint: Buffer;
  /** HMAC of the verified E.164 number; null if not yet verified. */
  phoneFingerprint: Buffer | null;
  /** 16-digit display number from the card-number algorithm (LLD §5.4). */
  cardNumber: string;
  alias: string;
  upiStyleId: string;
  /** Email or phone matched an unexpired identity tombstone: no starting grant. */
  isTombstoned: boolean;
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

async function loadExisting(client: PoolClient, userId: string): Promise<ProvisionResult | null> {
  const { rows } = await client.query<{
    ledger_account_id: string;
    bank_account_id: string;
    card_id: string;
    card_number: string;
    available_paise: string;
    journal_id: string | null;
    grant_id: string | null;
  }>(
    `SELECT la.id AS ledger_account_id, ba.id AS bank_account_id, vc.id AS card_id, vc.card_number,
            w.available_paise, gr.journal_id, gr.id AS grant_id
       FROM ledger.ledger_account la
       JOIN core.bank_account ba ON ba.ledger_account_id = la.id
       JOIN ledger.wallet w ON w.account_id = la.id
       JOIN core.virtual_card vc ON vc.bank_account_id = ba.id AND vc.status IN ('ACTIVE','FROZEN')
       LEFT JOIN ledger.grant_record gr ON gr.user_id = la.user_id AND gr.type = 'STARTER'
      WHERE la.user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    created: false,
    userId,
    ledgerAccountId: row.ledger_account_id,
    bankAccountId: row.bank_account_id,
    cardId: row.card_id,
    cardNumber: row.card_number,
    walletPaise: BigInt(row.available_paise),
    starterJournalId: row.journal_id,
    grantRecordId: row.grant_id,
  };
}

/**
 * LLD §7.1 provisioning, one transaction: profile (if absent), ledger account,
 * bank account, wallet, STARTER grant journal (skipped when tombstoned), grant
 * record, one ACTIVE card. Concurrent and repeated calls serialise on the
 * profile row lock and return the existing records; the grant is never repeated
 * (US-01, US-14). The one_starter unique index is the last line of defence.
 */
export async function provisionAccount(pool: Pool, input: ProvisionInput): Promise<ProvisionResult> {
  return withTransaction(
    pool,
    async (client) => {
      await client.query(
        `INSERT INTO core.user_profile (id, email_fingerprint, phone_fingerprint, phone_verified_at)
         VALUES ($1, $2, $3, CASE WHEN $3::bytea IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (id) DO NOTHING`,
        [input.userId, input.emailFingerprint, input.phoneFingerprint],
      );
      // Serialises every provisioning attempt for this user.
      await client.query("SELECT id FROM core.user_profile WHERE id = $1 FOR UPDATE", [input.userId]);

      const existing = await loadExisting(client, input.userId);
      if (existing) return existing;

      const ledgerAccountId = uuidv7();
      const bankAccountId = uuidv7();
      const cardId = uuidv7();

      await client.query("INSERT INTO ledger.ledger_account (id, type, user_id) VALUES ($1, 'USER', $2)", [
        ledgerAccountId,
        input.userId,
      ]);
      await client.query(
        `INSERT INTO core.bank_account (id, user_id, ledger_account_id, alias, upi_style_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [bankAccountId, input.userId, ledgerAccountId, input.alias, input.upiStyleId],
      );

      let walletPaise = 0n;
      let starterJournalId: string | null = null;
      let grantRecordId: string | null = null;

      if (!input.isTombstoned) {
        const { rows } = await client.query<{ id: number; starter: string | null }>(
          `SELECT id, values->>'starter_grant_paise' AS starter
             FROM core.config_version WHERE effective_from <= now() ORDER BY id DESC LIMIT 1`,
        );
        const config = rows[0];
        if (!config?.starter) throw new Error("No effective configuration with starter_grant_paise");
        const amount = BigInt(config.starter);
        starterJournalId = uuidv7();
        grantRecordId = uuidv7();

        await client.query(
          `INSERT INTO ledger.journal (id, event_type, config_version, funding_bank_account_id)
           VALUES ($1, 'STARTER_GRANT', $2, $3)`,
          [starterJournalId, config.id, bankAccountId],
        );
        await client.query(
          `INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES
             ($1, $2, $3, 'Starting grant'), ($1, $4, $5, 'Starting grant')`,
          [starterJournalId, MINT_ACCOUNT_ID, (-amount).toString(), ledgerAccountId, amount.toString()],
        );
        await client.query(
          `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
           VALUES ($1, $2, $3, 'STARTER', $4, (now() AT TIME ZONE 'UTC')::date)`,
          [grantRecordId, input.userId, starterJournalId, amount.toString()],
        );
        walletPaise = amount;
      }

      await client.query("INSERT INTO ledger.wallet (account_id, available_paise) VALUES ($1, $2)", [
        ledgerAccountId,
        walletPaise.toString(),
      ]);
      await client.query(
        `INSERT INTO core.virtual_card (id, user_id, bank_account_id, sequence, card_number, status)
         VALUES ($1, $2, $3, 1, $4, 'ACTIVE')`,
        [cardId, input.userId, bankAccountId, input.cardNumber],
      );
      await client.query("UPDATE core.user_profile SET provisioned_at = now() WHERE id = $1", [input.userId]);

      return {
        created: true,
        userId: input.userId,
        ledgerAccountId,
        bankAccountId,
        cardId,
        cardNumber: input.cardNumber,
        walletPaise,
        starterJournalId,
        grantRecordId,
      };
    },
    { userId: input.userId },
  );
}
