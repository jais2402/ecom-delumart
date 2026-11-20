import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINT_ACCOUNT_ID } from "../src/provision";
import {
  createProfile,
  createTestDatabase,
  inRolledBackTx,
  provisionAccount,
  provisionInput,
  sqlState,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

describe("ledger invariants", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let userAccount: string;
  let userId: string;
  let journalId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    const p = await provisionAccount(pool, provisionInput());
    userAccount = p.ledgerAccountId;
    userId = p.userId;
    if (!p.starterJournalId) throw new Error("expected a starter journal");
    journalId = p.starterJournalId;
  });
  afterAll(async () => {
    await db.drop();
  });

  async function insertJournal(c: pg.PoolClient, amounts: [string, bigint][]): Promise<string> {
    const id = uuidv7();
    await c.query("INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'COMPENSATION', 1)", [id]);
    for (const [account, amount] of amounts) {
      await c.query("INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'test')", [
        id,
        account,
        amount.toString(),
      ]);
    }
    return id;
  }

  it("zero-sum: an unbalanced journal is rejected at commit", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const id = await insertJournal(c, [
        [MINT_ACCOUNT_ID, -500n],
        [userAccount, 400n],
      ]);
      // the deferred constraint trigger has not fired yet: the statement itself succeeds
      const before = await c.query("SELECT 1 FROM ledger.journal WHERE id = $1", [id]);
      expect(before.rowCount).toBe(1);
      const err = await c.query("COMMIT").then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(/does not sum to zero/);
      const after = await pool.query("SELECT 1 FROM ledger.journal WHERE id = $1", [id]);
      expect(after.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it("zero-sum: a balanced journal commits", async () => {
    const c = await pool.connect();
    let id = "";
    try {
      await c.query("BEGIN");
      id = await insertJournal(c, [
        [MINT_ACCOUNT_ID, -500n],
        [userAccount, 300n],
        [userAccount, 200n],
      ]);
      await c.query("UPDATE ledger.wallet SET available_paise = available_paise + 500 WHERE account_id = $1", [
        userAccount,
      ]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const { rows } = await pool.query<{ s: string }>(
      "SELECT SUM(amount)::text AS s FROM ledger.posting WHERE journal_id = $1",
      [id],
    );
    expect(BigInt(rows[0]?.s ?? "x")).toBe(0n);
  });

  it("zero-sum: a posting of 0 paise is rejected", async () => {
    expect(
      await stateOf(pool, "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, 0, 'x')", [
        journalId,
        userAccount,
      ]),
    ).toBe("23514");
  });

  describe("append-only: rejected by trigger (as the owner / superuser)", () => {
    const cases: [string, string, () => unknown[]][] = [
      ["UPDATE ledger.posting", "UPDATE ledger.posting SET memo = 'edited' WHERE journal_id = $1", () => [journalId]],
      ["DELETE ledger.posting", "DELETE FROM ledger.posting WHERE journal_id = $1", () => [journalId]],
      ["UPDATE ledger.journal", "UPDATE ledger.journal SET idempotency_ref = NULL WHERE id = $1", () => [journalId]],
      ["DELETE ledger.journal", "DELETE FROM ledger.journal WHERE id = $1", () => [journalId]],
      ["UPDATE audit.audit_log", "UPDATE audit.audit_log SET reason = 'edited'", () => []],
      ["DELETE audit.audit_log", "DELETE FROM audit.audit_log", () => []],
      ["TRUNCATE ledger.posting", "TRUNCATE ledger.posting", () => []],
      ["TRUNCATE audit.audit_log", "TRUNCATE audit.audit_log", () => []],
    ];
    beforeAll(async () => {
      await pool.query(
        "INSERT INTO audit.audit_log (actor_kind, action, row_hash) VALUES ('SYSTEM', 'test', '\\x00'::bytea)",
      );
    });
    for (const [label, sql, params] of cases) {
      it(`${label} is rejected as append-only`, async () => {
        const err = await inRolledBackTx(pool, (c) =>
          c.query(sql, params()).then(
            () => null,
            (e: Error) => e,
          ),
        );
        expect(err?.message).toMatch(/is append-only/);
      });
    }
  });

  describe("append-only: rejected by missing grants for app_web (SET ROLE)", () => {
    const cases: [string, string, () => unknown[]][] = [
      ["UPDATE ledger.posting", "UPDATE ledger.posting SET memo = 'edited' WHERE journal_id = $1", () => [journalId]],
      ["DELETE ledger.posting", "DELETE FROM ledger.posting WHERE journal_id = $1", () => [journalId]],
      ["UPDATE ledger.journal", "UPDATE ledger.journal SET idempotency_ref = NULL WHERE id = $1", () => [journalId]],
      ["DELETE ledger.journal", "DELETE FROM ledger.journal WHERE id = $1", () => [journalId]],
      ["UPDATE audit.audit_log", "UPDATE audit.audit_log SET reason = 'edited'", () => []],
      ["DELETE audit.audit_log", "DELETE FROM audit.audit_log", () => []],
      ["UPDATE ledger.grant_record", "UPDATE ledger.grant_record SET amount = 1", () => []],
      ["DELETE ledger.grant_record", "DELETE FROM ledger.grant_record", () => []],
    ];
    for (const [label, sql, params] of cases) {
      it(`${label} as app_web fails with insufficient_privilege (42501)`, async () => {
        expect(await stateOf(pool, sql, params(), { role: "app_web" })).toBe("42501");
      });
    }
    it("privilege catalogue: app_web and app_jobs hold no UPDATE/DELETE/TRUNCATE on journal, posting, audit_log", async () => {
      const { rows } = await pool.query<{ role: string; tbl: string; priv: string; has: boolean }>(
        `SELECT r AS role, t AS tbl, p AS priv, has_table_privilege(r, t, p) AS has
           FROM unnest(ARRAY['app_web','app_jobs']) r,
                unnest(ARRAY['ledger.journal','ledger.posting','ledger.grant_record','audit.audit_log']) t,
                unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p`,
      );
      expect(rows.filter((r) => r.has)).toEqual([]);
      expect(rows.length).toBe(24);
    });
    it("app_web can still INSERT a balanced journal (insert-only, not read-only)", async () => {
      const state = await inRolledBackTx(pool, async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        const id = await insertJournal(c, [
          [MINT_ACCOUNT_ID, -7n],
          [userAccount, 7n],
        ]);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        return id;
      });
      expect(state).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it("wallet cannot go negative (CHECK available_paise >= 0)", async () => {
    expect(await stateOf(pool, "UPDATE ledger.wallet SET available_paise = -1 WHERE account_id = $1", [userAccount])).toBe(
      "23514",
    );
    expect(
      await stateOf(
        pool,
        "UPDATE ledger.wallet SET available_paise = available_paise - (available_paise + 1) WHERE account_id = $1",
        [userAccount],
      ),
    ).toBe("23514");
  });

  it("US-14: a second STARTER grant for a user is rejected", async () => {
    // the provisioned user already holds a STARTER grant
    const err = await inRolledBackTx(pool, (c) =>
      sqlState(
        c.query(
          "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount) VALUES ($1, $2, $3, 'STARTER', 1)",
          [uuidv7(), userId, journalId],
        ),
      ),
    );
    expect(err).toBe("23505");
  });

  it("a second RELIEF grant on the same UTC day is rejected; the next day is allowed", async () => {
    const other = await createProfile(pool);
    const insertRelief = (c: pg.PoolClient, day: string) =>
      c.query(
        "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day) VALUES ($1, $2, $3, 'RELIEF', 100, $4)",
        [uuidv7(), other, journalId, day],
      );
    await inRolledBackTx(pool, async (c) => {
      await insertRelief(c, "2026-11-20");
      await c.query("SAVEPOINT s");
      expect(await sqlState(insertRelief(c, "2026-11-20"))).toBe("23505");
      await c.query("ROLLBACK TO SAVEPOINT s");
      expect(await sqlState(insertRelief(c, "2026-11-21"))).toBe("no error");
    });
  });
});
