import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINT_ACCOUNT_ID, type ProvisionResult, SINK_ACCOUNT_ID } from "../src/provision";
import {
  type Actor,
  commitError,
  commitState,
  createTestDatabase,
  provisionAccount,
  provisionInput,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

/** Inserts a journal of `type` with the given postings; optionally syncs the touched USER wallets. */
async function journal(
  c: pg.PoolClient,
  type: string,
  postings: [string, number][],
  syncWallets: string[] = [],
): Promise<string> {
  const j = uuidv7();
  await c.query("INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)", [j, type]);
  for (const [account, amount] of postings) {
    await c.query(
      "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
      [j, account, amount],
    );
  }
  if (syncWallets.length > 0) await c.query("SELECT ledger.sync_wallets($1)", [syncWallets]);
  return j;
}

describe("ledger gaps: journal types by role, wallet sync at commit, MINT in PURCHASE", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: ProvisionResult;
  let b: ProvisionResult;
  const web = (): Actor => ({ role: "app_web", userId: a.userId });
  const jobs: Actor = { role: "app_jobs" };

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    a = await provisionAccount(pool, provisionInput());
    b = await provisionAccount(pool, provisionInput());
  });
  afterAll(async () => {
    await db.drop();
  });

  describe("A1: app_web may insert only user-driven journal types", () => {
    for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
      it(`app_web cannot insert a ${type} journal (admin actions run in the job runner)`, async () => {
        expect(
          await stateOf(
            pool,
            "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)",
            [uuidv7(), type],
            web(),
          ),
        ).toBe("42501");
      });
    }

    it("app_web cannot mint to itself with a COMPENSATION journal, even balanced and synced", async () => {
      const state = await commitState(pool, web(), (c) =>
        journal(
          c,
          "COMPENSATION",
          [
            [MINT_ACCOUNT_ID, -5],
            [a.ledgerAccountId, 5],
          ],
          [a.ledgerAccountId],
        ),
      );
      expect(state).toBe("42501");
    });

    for (const type of [
      "STARTER_GRANT",
      "RELIEF_GRANT",
      "PURCHASE",
      "COMPANY_REGISTRATION",
      "WAREHOUSE_PURCHASE",
      "MEMBERSHIP",
    ]) {
      it(`app_web may insert a ${type} journal row`, async () => {
        expect(
          await stateOf(
            pool,
            "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)",
            [uuidv7(), type],
            web(),
          ),
        ).toBe("no error");
      });
    }

    it("app_jobs may post a COMPENSATION journal crediting one user from MINT", async () => {
      const state = await commitState(pool, jobs, (c) =>
        journal(
          c,
          "COMPENSATION",
          [
            [MINT_ACCOUNT_ID, -5],
            [a.ledgerAccountId, 5],
          ],
          [a.ledgerAccountId],
        ),
      );
      expect(state).toBe("no error");
    });

    for (const type of ["REVERSAL", "ACCOUNT_RETIREMENT"]) {
      it(`app_jobs may insert a ${type} journal row`, async () => {
        expect(
          await stateOf(
            pool,
            "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)",
            [uuidv7(), type],
            jobs,
          ),
        ).toBe("no error");
      });
    }
  });

  describe("A2: every USER account that received postings has a matching wallet at commit", () => {
    it("app_web: a PURCHASE debiting the buyer without a wallet update is rejected at commit", async () => {
      const message = await commitError(pool, web(), (c) =>
        journal(c, "PURCHASE", [
          [a.ledgerAccountId, -700],
          [SINK_ACCOUNT_ID, 700],
        ]),
      );
      expect(message).toMatch(/received postings .* wallet/);
    });

    it("app_web: crediting another user's account without syncing their wallet is rejected at commit", async () => {
      const message = await commitError(pool, web(), async (c) => {
        await journal(c, "PURCHASE", [
          [a.ledgerAccountId, -900],
          [b.ledgerAccountId, 800],
          [SINK_ACCOUNT_ID, 100],
        ]);
        await c.query(
          "UPDATE ledger.wallet SET available_paise = available_paise - 900 WHERE account_id = $1",
          [a.ledgerAccountId],
        );
      });
      expect(message).toMatch(/received postings .* wallet/);
    });

    it("not even the owner can commit postings to a USER account without the wallet reflecting them", async () => {
      const state = await commitState(pool, {}, (c) =>
        journal(c, "PURCHASE", [
          [a.ledgerAccountId, -1],
          [SINK_ACCOUNT_ID, 1],
        ]),
      );
      expect(state).toBe("23514");
    });

    it("a USER account with postings but no wallet row is rejected at commit", async () => {
      const message = await commitError(pool, {}, async (c) => {
        const userId = uuidv7();
        await c.query("INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)", [
          userId,
          randomBytes(32),
        ]);
        const account = uuidv7();
        await c.query("INSERT INTO ledger.ledger_account (id, type, user_id) VALUES ($1, 'USER', $2)", [
          account,
          userId,
        ]);
        await journal(c, "COMPENSATION", [
          [MINT_ACCOUNT_ID, -5],
          [account, 5],
        ]);
      });
      expect(message).toMatch(/received postings .* wallet/);
    });

    it("postings matched by ledger.sync_wallets for buyer and seller commit", async () => {
      const state = await commitState(pool, web(), (c) =>
        journal(
          c,
          "PURCHASE",
          [
            [a.ledgerAccountId, -900],
            [b.ledgerAccountId, 800],
            [SINK_ACCOUNT_ID, 100],
          ],
          [a.ledgerAccountId, b.ledgerAccountId],
        ),
      );
      expect(state).toBe("no error");
    });
  });

  describe("A3: MINT is never debited in a PURCHASE journal (no platform coupons yet)", () => {
    it("a PURCHASE journal debiting MINT is rejected at commit, even when balanced and synced", async () => {
      const message = await commitError(pool, web(), (c) =>
        journal(
          c,
          "PURCHASE",
          [
            [a.ledgerAccountId, -900],
            [MINT_ACCOUNT_ID, -100],
            [SINK_ACCOUNT_ID, 1000],
          ],
          [a.ledgerAccountId],
        ),
      );
      expect(message).toMatch(/PURCHASE journal .* MINT/);
    });

    it("the owner cannot debit MINT in a PURCHASE journal either", async () => {
      const state = await commitState(pool, {}, (c) =>
        journal(
          c,
          "PURCHASE",
          [
            [MINT_ACCOUNT_ID, -100],
            [a.ledgerAccountId, 100],
          ],
          [a.ledgerAccountId],
        ),
      );
      expect(state).toBe("23514");
    });
  });
});
