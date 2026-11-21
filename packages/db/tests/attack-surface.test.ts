import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINT_ACCOUNT_ID } from "../src/provision";
import {
  asActor,
  commitState,
  countRows,
  createTestDatabase,
  plant,
  provisionAccount,
  provisionInput,
  RAW_WRITER,
  sqlState,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

/**
 * One place that states what the web process (app_web, signed in as A) cannot do,
 * whatever SQL it is tricked into running. Each line is a security review finding.
 */
describe("attack surface: app_web acting as user A", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: TestUser;
  let b: TestUser;
  let tombstone: Buffer;
  const group = uuidv7();
  const asA = () => ({ role: "app_web", userId: a.userId });

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    a = await provisionAccount(pool, provisionInput());
    b = await provisionAccount(pool, provisionInput());
    await pool.query(
      "INSERT INTO private.address (id, user_id, kind, label, payload_enc) VALUES ($1, $2, 'REAL', 'HOME', $3)",
      [uuidv7(), b.userId, randomBytes(48)],
    );
    await pool.query(
      "INSERT INTO core.idempotency_record (user_id, command, key, request_hash) VALUES ($1, 'pay', 'k', '\\x00')",
      [b.userId],
    );
    // visibility fixture: an order without journal, session or attempt cannot be created under
    // the money rules (0016), so it is planted with triggers and foreign keys off
    await plant(pool, async (c) => {
      await c.query(
        `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
         VALUES ($1, $2, $3, $4, $5, 'PLAYER', 10000, 1)`,
        [group, b.userId, uuidv7(), uuidv7(), uuidv7()],
      );
      await c.query(
        `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise)
         VALUES ($1, $2, $3, NULL, 'SEED', 10000, 0, 10000)`,
        [uuidv7(), group, b.userId],
      );
    });
    tombstone = randomBytes(32);
    await pool.query(
      "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '30 days')",
      [tombstone],
    );
  });
  afterAll(async () => {
    await db.drop();
  });

  it("cannot read another user's profile, wallet, postings, idempotency records, orders or addresses", async () => {
    const seen = await asActor(pool, asA(), async (c) => ({
      profile: await countRows(c, "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", [b.userId]),
      wallet: await countRows(c, "SELECT count(*) AS n FROM ledger.wallet WHERE account_id = $1", [
        b.ledgerAccountId,
      ]),
      postings: await countRows(c, "SELECT count(*) AS n FROM ledger.posting WHERE account_id = $1", [
        b.ledgerAccountId,
      ]),
      idempotency: await countRows(
        c,
        "SELECT count(*) AS n FROM core.idempotency_record WHERE user_id = $1",
        [b.userId],
      ),
      orderGroups: await countRows(c, "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [
        b.userId,
      ]),
      sellerOrders: await countRows(
        c,
        "SELECT count(*) AS n FROM core.seller_order WHERE order_group_id = $1",
        [group],
      ),
      addresses: await countRows(c, "SELECT count(*) AS n FROM private.address WHERE user_id = $1", [
        b.userId,
      ]),
    }));
    expect(seen).toEqual({
      profile: 0,
      wallet: 0,
      postings: 0,
      idempotency: 0,
      orderGroups: 0,
      sellerOrders: 0,
      addresses: 0,
    });
    // the rows exist: the owner sees them
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [
        b.userId,
      ]),
    ).toBe(1);
    // and it cannot even name the buyer column of a seller order (purchases are anonymous to sellers)
    expect(
      await asActor(pool, asA(), (c) =>
        sqlState(c.query("SELECT count(*) FROM core.seller_order WHERE buyer_user_id = $1", [b.userId])),
      ),
    ).toBe("42501");
  });

  it("cannot raise its own role", async () => {
    const state = await asActor(pool, asA(), (c) =>
      sqlState(c.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [a.userId])),
    );
    expect(state).toBe("42501");
  });

  it("cannot insert configuration", async () => {
    const state = await asActor(pool, asA(), (c) =>
      sqlState(
        c.query(
          `INSERT INTO core.config_version (values, effective_from) VALUES ('{"starter_grant_paise":"1000000000000000"}', now())`,
        ),
      ),
    );
    expect(state).toBe("42501");
  });

  it("cannot update a wallet (no privilege), nor can app_pay; a writer the grants missed is refused without postings", async () => {
    const raise = (c: pg.PoolClient) =>
      c.query("UPDATE ledger.wallet SET available_paise = available_paise + 100000 WHERE account_id = $1", [
        a.ledgerAccountId,
      ]);
    expect(await commitState(pool, asA(), raise)).toBe("42501");
    expect(await commitState(pool, { role: "app_pay", userId: a.userId }, raise)).toBe("42501");
    expect(await commitState(pool, { role: RAW_WRITER, userId: a.userId }, raise)).toBe("23514");
  });

  it("cannot add postings to an old journal (no privilege), nor can app_pay; nor a writer the grants missed", async () => {
    const post = (c: pg.PoolClient) =>
      c.query(
        "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -100000, 'x'), ($1, $3, 100000, 'x')",
        [a.starterJournalId, MINT_ACCOUNT_ID, a.ledgerAccountId],
      );
    expect(await commitState(pool, asA(), post)).toBe("42501");
    expect(await commitState(pool, { role: "app_pay", userId: a.userId }, post)).toBe("42501");
    // (refused before the closed-journal rule: the provisioning call checked and sealed it)
    expect(await commitState(pool, { role: RAW_WRITER, userId: a.userId }, post)).toBe("23514");
  });

  it("cannot delete a tombstone", async () => {
    const state = await asActor(pool, asA(), (c) =>
      sqlState(c.query("DELETE FROM core.identity_tombstone WHERE fingerprint = $1", [tombstone])),
    );
    expect(state).toBe("42501");
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM core.identity_tombstone WHERE fingerprint = $1", [
        tombstone,
      ]),
    ).toBe(1);
  });
});
