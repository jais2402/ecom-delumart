import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINT_ACCOUNT_ID, SINK_ACCOUNT_ID, STARTER_GRANT_PAISE } from "../src/provision";
import {
  checkout,
  journalPostings,
  payFor,
  product,
  RUPEE,
  seller,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  commitError,
  commitState,
  createTestDatabase,
  provisionAccount,
  provisionInput,
  RAW_WRITER,
  stateOf,
  type TestDatabase,
  type TestUser,
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
  let a: TestUser;
  let b: TestUser;
  const web = (): Actor => ({ role: "app_web", userId: a.userId });
  const payRole = (): Actor => ({ role: "app_pay", userId: a.userId });
  /** a writer the grants did not stop (helpers.ts): the structural rules alone refuse it */
  const raw = (): Actor => ({ role: RAW_WRITER, userId: a.userId });
  const jobs: Actor = { role: "app_jobs" };
  /** the database owner (the only role that may post admin journal types) */
  const owner: Actor = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    a = await provisionAccount(pool, provisionInput());
    b = await provisionAccount(pool, provisionInput());
  });
  afterAll(async () => {
    await db.drop();
  });

  describe("A1: no application role inserts a journal at all; admin types only by the owner", () => {
    for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
      for (const role of ["app_web", "app_pay"]) {
        it(`${role} cannot insert a ${type} journal (admin actions: the owner only)`, async () => {
          expect(
            await stateOf(
              pool,
              "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)",
              [uuidv7(), type],
              { role, userId: a.userId },
            ),
          ).toBe("42501");
        });
      }
    }

    it("app_pay cannot mint to itself with a COMPENSATION journal, even balanced and synced", async () => {
      const state = await commitState(pool, payRole(), (c) =>
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

    for (const type of ["STARTER_GRANT", "RELIEF_GRANT", "PURCHASE"]) {
      it(`neither app_pay nor app_web may insert a ${type} journal row (the command functions write them)`, async () => {
        const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
        expect(await stateOf(pool, insert, [uuidv7(), type], payRole())).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], web())).toBe("42501");
        // the row itself is acceptable to the per-row rules (its checks run at commit)
        expect(await stateOf(pool, insert, [uuidv7(), type], raw())).toBe("no error");
      });
    }

    // Nothing backs these yet (no registration, warehouse or membership records and checks),
    // so neither application role may create them: they would only burn money (0014, 0016).
    for (const type of ["COMPANY_REGISTRATION", "WAREHOUSE_PURCHASE", "MEMBERSHIP"]) {
      it(`neither app_pay nor app_web may insert a ${type} journal row (unbacked)`, async () => {
        const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
        expect(await stateOf(pool, insert, [uuidv7(), type], payRole())).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], web())).toBe("42501");
      });
    }

    it("a writer the grants missed cannot create admin journal types either (role rule, 0016)", async () => {
      const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
      for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
        expect(await stateOf(pool, insert, [uuidv7(), type], raw()), type).toBe("42501");
      }
    });

    it("only the owner may post a COMPENSATION journal crediting one user from MINT; the job runner may not (fourth review)", async () => {
      const compensate = (c: pg.PoolClient) =>
        journal(
          c,
          "COMPENSATION",
          [
            [MINT_ACCOUNT_ID, -5],
            [a.ledgerAccountId, 5],
          ],
          [a.ledgerAccountId],
        );
      expect(await commitState(pool, jobs, compensate)).toBe("42501");
      expect(await commitState(pool, owner, compensate)).toBe("no error");
    });

    for (const type of ["REVERSAL", "ACCOUNT_RETIREMENT"]) {
      it(`only the owner may insert a ${type} journal row (not the job runner)`, async () => {
        const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
        expect(await stateOf(pool, insert, [uuidv7(), type], jobs)).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], owner)).toBe("no error");
      });
    }
  });

  describe("A2: every USER account that received postings has a matching wallet at commit", () => {
    it("a journal debiting a user without a wallet update is rejected at commit", async () => {
      // (app_pay's own debits are PURCHASEs, which need a whole order group, 0016; an owner
      // REVERSAL debits a user the same way)
      const message = await commitError(pool, owner, (c) =>
        journal(c, "REVERSAL", [
          [a.ledgerAccountId, -700],
          [SINK_ACCOUNT_ID, 700],
        ]),
      );
      expect(message).toMatch(/received postings .* wallet/);
    });

    it("crediting another user's account without syncing their wallet is rejected at commit", async () => {
      // (since 0016 only a complete PURCHASE credits another user from a user's journal, so
      // the credit here comes from an owner COMPENSATION)
      const message = await commitError(pool, owner, (c) =>
        journal(c, "COMPENSATION", [
          [MINT_ACCOUNT_ID, -800],
          [b.ledgerAccountId, 800],
        ]),
      );
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
        await c.query("INSERT INTO auth.users (id) VALUES ($1)", [userId]);
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

    it("postings matched by ledger.sync_wallets for buyer and seller commit (a real purchase)", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 900n * RUPEE });
      const receipt = await payFor(pool, buyer, await checkout(pool, buyer, [p], standard(s)));
      const postings = await journalPostings(pool, receipt.orderGroupId);
      expect(await wallet(pool, buyer.ledgerAccountId)).toBe(
        STARTER_GRANT_PAISE + (postings.get(buyer.ledgerAccountId) ?? 0n),
      );
      expect(await wallet(pool, s.owner.ledgerAccountId)).toBe(
        STARTER_GRANT_PAISE + (postings.get(s.owner.ledgerAccountId) ?? 0n),
      );
      expect(postings.get(s.owner.ledgerAccountId)).toBe(855n * RUPEE);
    });
  });

  describe("A3: MINT is never debited in a PURCHASE journal (no platform coupons yet)", () => {
    it("a PURCHASE journal debiting MINT is rejected at commit, even when balanced and synced", async () => {
      const mint = (c: pg.PoolClient) =>
        journal(
          c,
          "PURCHASE",
          [
            [a.ledgerAccountId, -900],
            [MINT_ACCOUNT_ID, -100],
            [SINK_ACCOUNT_ID, 1000],
          ],
          [a.ledgerAccountId],
        );
      expect(await commitState(pool, payRole(), mint)).toBe("42501");
      expect(await commitError(pool, raw(), mint)).toMatch(/PURCHASE journal .* MINT/);
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
