import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SINK_ACCOUNT_ID } from "../src/provision";
import { withTransaction } from "../src/transaction";
import { createTestDatabase, provisionAccount, provisionInput, type TestDatabase, uuidv7 } from "./helpers";

const STARTER = 100_000_000_000n;

async function count(pool: pg.Pool, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

/** LLD §5.9 reconciliation queries 1-3, plus the wallet check extended to wallets without postings. */
async function reconcile(pool: pg.Pool) {
  const unbalanced = await pool.query(
    "SELECT journal_id FROM ledger.posting GROUP BY journal_id HAVING SUM(amount) <> 0",
  );
  const walletMismatch = await pool.query(
    `SELECT w.account_id FROM ledger.wallet w
     JOIN (SELECT account_id, SUM(amount) s FROM ledger.posting GROUP BY account_id) p USING (account_id)
     WHERE w.available_paise <> p.s`,
  );
  const walletMismatchIncludingEmpty = await pool.query(
    `SELECT w.account_id FROM ledger.wallet w
     LEFT JOIN (SELECT account_id, SUM(amount) s FROM ledger.posting GROUP BY account_id) p USING (account_id)
     WHERE w.available_paise <> COALESCE(p.s, 0)`,
  );
  const total = await pool.query<{ s: string | null }>("SELECT SUM(amount)::text AS s FROM ledger.posting");
  return {
    unbalanced: unbalanced.rowCount,
    walletMismatch: walletMismatch.rowCount,
    walletMismatchIncludingEmpty: walletMismatchIncludingEmpty.rowCount,
    total: BigInt(total.rows[0]?.s ?? "0"),
  };
}

describe("provisionAccount", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 15 });
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  it("US-01: provisions profile, ledger account, bank account, wallet of ₹100 crore, STARTER grant and one ACTIVE card", async () => {
    const input = provisionInput();
    const r = await provisionAccount(pool, input);
    expect(r.created).toBe(true);
    expect(r.walletPaise).toBe(STARTER);
    const { rows } = await pool.query<{ amount: string; account_id: string }>(
      "SELECT amount, account_id FROM ledger.posting WHERE journal_id = $1 ORDER BY amount",
      [r.starterJournalId],
    );
    expect(rows.map((x) => BigInt(x.amount))).toEqual([-STARTER, STARTER]);
    expect(rows[1]?.account_id).toBe(r.ledgerAccountId);
    const card = await pool.query<{ status: string; card_number: string }>(
      "SELECT status, card_number FROM core.virtual_card WHERE user_id = $1",
      [input.userId],
    );
    expect(card.rows).toEqual([{ status: "ACTIVE", card_number: input.cardNumber }]);
    const profile = await pool.query(
      "SELECT 1 FROM core.user_profile WHERE id = $1 AND provisioned_at IS NOT NULL",
      [input.userId],
    );
    expect(profile.rowCount).toBe(1);
  });

  it("US-14: calling again returns the existing records and never grants twice", async () => {
    const input = provisionInput();
    const first = await provisionAccount(pool, input);
    const again = await provisionAccount(pool, { ...input, cardNumber: provisionInput().cardNumber });
    expect(again).toEqual({ ...first, created: false });
    expect(
      await count(pool, "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1", [input.userId]),
    ).toBe(1);
  });

  async function tombstone(fingerprint: Buffer, kind: "EMAIL" | "PHONE", expiresIn: string): Promise<void> {
    await pool.query(
      `INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, $2, now() + $3::interval)`,
      [fingerprint, kind, expiresIn],
    );
  }

  it("tombstoned identity: provisioned without a starting grant, wallet 0", async () => {
    const input = provisionInput();
    await tombstone(input.emailFingerprint, "EMAIL", "30 days");
    const r = await provisionAccount(pool, input);
    expect(r.walletPaise).toBe(0n);
    expect(r.starterJournalId).toBeNull();
    expect(r.grantRecordId).toBeNull();
    expect(
      await count(pool, "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1", [input.userId]),
    ).toBe(0);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.virtual_card WHERE user_id = $1", [input.userId]),
    ).toBe(1);
  });

  it("tombstone lookup happens inside provisioning: a tombstoned phone also skips the grant, as app_pay", async () => {
    const input = provisionInput();
    if (!input.phoneFingerprint) throw new Error("fixture has a phone");
    await tombstone(input.phoneFingerprint, "PHONE", "30 days");
    const r = await withLogin(db.url, "app_pay", (p) => provisionAccount(p, input));
    expect(r.created).toBe(true);
    expect(r.walletPaise).toBe(0n);
    expect(r.grantRecordId).toBeNull();
  });

  it("an expired tombstone no longer blocks the starting grant", async () => {
    const input = provisionInput();
    await tombstone(input.emailFingerprint, "EMAIL", "-1 day");
    const r = await provisionAccount(pool, input);
    expect(r.walletPaise).toBe(STARTER);
  });

  it("finding 1: the STARTER amount is the fixed constant, whatever the newest configuration says", async () => {
    await pool.query(
      `INSERT INTO core.config_version (values, effective_from, note)
       VALUES ('{"starter_grant_paise":"999999999999999"}', now() - interval '1 second', 'hostile')`,
    );
    const r = await provisionAccount(pool, provisionInput());
    expect(r.walletPaise).toBe(STARTER);
    const { rows } = await pool.query<{ amount: string }>(
      "SELECT amount FROM ledger.grant_record WHERE id = $1",
      [r.grantRecordId],
    );
    expect(rows.map((x) => BigInt(x.amount))).toEqual([STARTER]);
  });

  it("provisioning works as app_pay under row-level security (app.user_id set by withTransaction)", async () => {
    const input = provisionInput();
    await withLogin(db.url, "app_pay", async (appPayPool) => {
      const r = await provisionAccount(appPayPool, input);
      expect(r.created).toBe(true);
      expect(r.walletPaise).toBe(STARTER);
      const again = await provisionAccount(appPayPool, input);
      expect(again.created).toBe(false);
    });
  });

  it("security review: a connection logged in as app_web cannot provision (it cannot become app_pay)", async () => {
    const input = provisionInput();
    const outcome = await withLogin(db.url, "app_web", (p) => provisionAccount(p, input)).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "unknown",
    );
    expect(outcome).toBe("42501");
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", [input.userId]),
    ).toBe(0);
  });

  it("US-14 concurrency from an existing profile row: 20 parallel calls create exactly one grant", async () => {
    const input = provisionInput();
    await pool.query(
      "INSERT INTO core.user_profile (id, email_fingerprint, phone_fingerprint) VALUES ($1, $2, $3)",
      [input.userId, input.emailFingerprint, input.phoneFingerprint],
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        provisionAccount(pool, i === 0 ? input : { ...input, ...pick(provisionInput()) }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const u = [input.userId];
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1 AND type = 'STARTER'",
        u,
      ),
    ).toBe(1);
    expect(await count(pool, "SELECT count(*) AS n FROM core.virtual_card WHERE user_id = $1", u)).toBe(1);
    for (const r of results) expect(r.walletPaise).toBe(STARTER);
  });

  it("US-01/US-14 concurrency: 10 simultaneous provisionAccount calls for one user create exactly one of everything", async () => {
    const input = provisionInput();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        // every caller presents different card/alias values; only one may win
        provisionAccount(pool, i === 0 ? input : { ...input, ...pick(provisionInput()) }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created);
    for (const r of results) expect({ ...r, created: true }).toEqual(winner);

    const u = [input.userId];
    expect(await count(pool, "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", u)).toBe(1);
    expect(await count(pool, "SELECT count(*) AS n FROM ledger.ledger_account WHERE user_id = $1", u)).toBe(
      1,
    );
    expect(await count(pool, "SELECT count(*) AS n FROM core.bank_account WHERE user_id = $1", u)).toBe(1);
    expect(await count(pool, "SELECT count(*) AS n FROM core.virtual_card WHERE user_id = $1", u)).toBe(1);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1 AND type = 'STARTER'",
        u,
      ),
    ).toBe(1);
    const wallet = await pool.query<{ available_paise: string }>(
      `SELECT w.available_paise FROM ledger.wallet w JOIN ledger.ledger_account la ON la.id = w.account_id
        WHERE la.user_id = $1`,
      u,
    );
    expect(wallet.rows.map((w) => BigInt(w.available_paise))).toEqual([STARTER]);
  });

  it("global conservation: after several provisions SUM(posting.amount) = 0 and each wallet equals its postings (LLD §5.9)", async () => {
    await Promise.all(Array.from({ length: 5 }, () => provisionAccount(pool, provisionInput())));
    const tombstoned = provisionInput();
    await tombstone(tombstoned.emailFingerprint, "EMAIL", "30 days");
    await provisionAccount(pool, tombstoned);
    const r = await reconcile(pool);
    expect(r).toEqual({ unbalanced: 0, walletMismatch: 0, walletMismatchIncludingEmpty: 0, total: 0n });
    const wallets = await count(pool, "SELECT count(*) AS n FROM ledger.wallet", []);
    expect(wallets).toBeGreaterThanOrEqual(6);
  });

  it("concurrency: two transactions locking the same wallet FOR UPDATE and each debiting > half — exactly one succeeds, balance never negative", async () => {
    const buyer = await provisionAccount(pool, provisionInput());
    const debit = (STARTER * 6n) / 10n;

    const spend = (): Promise<"ok" | "INSUFFICIENT_FUNDS"> =>
      withTransaction(
        pool,
        async (c) => {
          const { rows } = await c.query<{ available_paise: string }>(
            "SELECT available_paise FROM ledger.wallet WHERE account_id = $1 FOR UPDATE",
            [buyer.ledgerAccountId],
          );
          const available = BigInt(rows[0]?.available_paise ?? "0");
          if (available < debit) return "INSUFFICIENT_FUNDS";
          const journal = uuidv7();
          await c.query(
            "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'MEMBERSHIP', 1)",
            [journal],
          );
          await c.query(
            `INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES
             ($1, $2, $3, 'purchase'), ($1, $4, $5, 'purchase')`,
            [journal, buyer.ledgerAccountId, (-debit).toString(), SINK_ACCOUNT_ID, debit.toString()],
          );
          await c.query(
            "UPDATE ledger.wallet SET available_paise = available_paise - $2, version = version + 1 WHERE account_id = $1",
            [buyer.ledgerAccountId, debit.toString()],
          );
          await c.query("SELECT pg_sleep(0.2)"); // hold the lock so the other transaction must wait on it
          return "ok";
        },
        { userId: buyer.userId },
      );

    const outcomes = await Promise.all([spend(), spend()]);
    expect(outcomes.sort()).toEqual(["INSUFFICIENT_FUNDS", "ok"]);
    const { rows } = await pool.query<{ available_paise: string }>(
      "SELECT available_paise FROM ledger.wallet WHERE account_id = $1",
      [buyer.ledgerAccountId],
    );
    expect(BigInt(rows[0]?.available_paise ?? "-1")).toBe(STARTER - debit);
    expect((await reconcile(pool)).total).toBe(0n);
  });

  it("concurrency: even without the application check, the CHECK constraint stops the second blind debit", async () => {
    // Finding 3: a wallet change must be matched by postings, so each blind debit posts a
    // balanced journal of the user's own (MEMBERSHIP: user -> SINK; a PURCHASE needs a whole
    // order since 0016) first; neither transaction checks the balance itself.
    const buyer = await provisionAccount(pool, provisionInput());
    const debit = ((STARTER * 6n) / 10n).toString();
    const blind = () =>
      withTransaction(
        pool,
        async (c) => {
          const journal = uuidv7();
          await c.query(
            "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'MEMBERSHIP', 1)",
            [journal],
          );
          await c.query(
            `INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES
             ($1, $2, -$3::bigint, 'blind'), ($1, $4, $3::bigint, 'blind')`,
            [journal, buyer.ledgerAccountId, debit, SINK_ACCOUNT_ID],
          );
          await c.query(
            "UPDATE ledger.wallet SET available_paise = available_paise - $2 WHERE account_id = $1",
            [buyer.ledgerAccountId, debit],
          );
          await c.query("SELECT pg_sleep(0.2)");
        },
        { userId: buyer.userId },
      ).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? "unknown",
      );
    const outcomes = await Promise.all([blind(), blind()]);
    expect(outcomes.sort()).toEqual(["23514", "ok"]);
    expect((await reconcile(pool)).walletMismatchIncludingEmpty).toBe(0);
  });

  it("finding 3: a wallet update without postings is rejected at commit (the old blind debit)", async () => {
    const buyer = await provisionAccount(pool, provisionInput());
    const outcome = await withTransaction(pool, (c) =>
      c.query("UPDATE ledger.wallet SET available_paise = available_paise - 1 WHERE account_id = $1", [
        buyer.ledgerAccountId,
      ]),
    ).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "unknown",
    );
    expect(outcome).toBe("23514");
  });
});

function pick(i: ReturnType<typeof provisionInput>) {
  return { cardNumber: i.cardNumber, alias: i.alias, upiStyleId: i.upiStyleId };
}

/**
 * Runs fn with a one-connection "pool" logged in as `role`: SET SESSION AUTHORIZATION makes
 * it the session user, exactly like a login with that role's credential, so SET ROLE to a
 * role it is not a member of fails (as it would in production).
 */
async function withLogin<T>(
  url: string,
  role: "app_web" | "app_pay",
  fn: (p: pg.Pool) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`SET SESSION AUTHORIZATION ${role}`);
    const asPoolClient = Object.assign(client, { release: () => undefined }) as unknown as pg.PoolClient;
    return await fn({ connect: async () => asPoolClient } as unknown as pg.Pool);
  } finally {
    await client.end();
  }
}
