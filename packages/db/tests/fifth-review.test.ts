import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cartAdd } from "../src/cart";
import { rateHit } from "../src/rate";
import { withTransaction } from "../src/transaction";
import {
  CLEAN,
  checkout,
  codeOf,
  payFor,
  product,
  RUPEE,
  reconcile,
  standard,
  user,
} from "./checkout-fixtures";
import { ADMIN_URL, createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";

/**
 * Fifth security review, item 2: advisory-lock denial of service (migration 0030). Each test names
 * the part it covers and fails without it.
 */
describe("fifth security review: advisory locks", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let victim: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 30 });
    pool = db.pool;
    victim = await user(pool);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const APP_ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"] as const;

  it("item 2a: no application role can take, try or release an advisory lock (session or transaction level)", async () => {
    for (const role of APP_ROLES) {
      for (const sql of [
        "SELECT pg_advisory_lock(1)",
        "SELECT pg_try_advisory_lock(1)",
        "SELECT pg_advisory_xact_lock(1)",
        "SELECT pg_try_advisory_xact_lock(1)",
        "SELECT pg_advisory_lock_shared(1)",
        "SELECT pg_advisory_lock(1, 2)",
        "SELECT pg_advisory_unlock_all()",
      ]) {
        expect(await stateOf(pool, sql, [], { role }), `${role}: ${sql}`).toBe("42501");
      }
    }
    // control: the owner (the migration runner) still can
    expect(await stateOf(pool, "SELECT pg_advisory_xact_lock(1)")).toBe("no error");
  });

  it("item 2a: the per-actor lock rows and the audit chain head are owner-only", async () => {
    for (const role of APP_ROLES) {
      for (const sql of [
        "SELECT 1 FROM core.actor_lock FOR UPDATE",
        "INSERT INTO core.actor_lock (kind, subject) VALUES ('core.cart_line', gen_random_uuid())",
        "SELECT core.lock_actor('core.cart_line', gen_random_uuid())",
        "SELECT 1 FROM audit.chain_head FOR UPDATE",
        "SELECT audit.append_chained(NULL, 'SYSTEM', 'x', NULL, NULL, NULL, NULL)",
      ]) {
        expect(await stateOf(pool, sql, [], { role }), `${role}: ${sql}`).toBe("42501");
      }
    }
  });

  it("item 2a: the reviewer's attack — session-level advisory locks on the victim's predictable keys, held idle outside a transaction — no longer blocks the victim's cart add, checkout or payment", async () => {
    const holder = await pool.connect();
    try {
      // as app_web (the reviewer's login): refused outright
      await holder.query("SET ROLE app_web");
      const keyOf = (kind: string) => `${kind}:${victim.userId}`;
      expect(
        await codeOf(
          holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [keyOf("core.cart_line")]),
        ),
      ).toBe("42501");
      await holder.query("RESET ROLE");
      // and even if a login still could (a platform where the revoke does not apply), the old keys
      // no longer serialise anything: hold every one of them, idle, outside a transaction
      for (const kind of ["core.cart_line", "core.checkout_session", "core.payment_attempt"]) {
        await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [keyOf(kind)]);
      }
      await holder.query("SELECT pg_advisory_lock(hashtextextended('audit.audit_log:chain', 0))");

      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 300n * RUPEE });
      const started = Date.now();
      await cartAdd(pool, { authSessionId: victim.authSessionId, productId: p.id });
      const co = await checkout(pool, victim, [p], standard("SEED"));
      expect(await codeOf(payFor(pool, victim, co))).toBe("ok");
      expect(Date.now() - started).toBeLessThan(1_500); // no 2 s lock_timeout was waited out
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
    }
  });

  it("item 2a: per-actor serialisation still holds — another transaction holding the actor's cart lock row makes the cart add wait (BUSY at the lock timeout)", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT core.lock_actor('core.cart_line', $1)", [victim.userId]);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 301n * RUPEE });
      expect(await codeOf(cartAdd(pool, { authSessionId: victim.authSessionId, productId: p.id }))).toBe(
        "BUSY",
      );
      await holder.query("ROLLBACK");
      expect(await codeOf(cartAdd(pool, { authSessionId: victim.authSessionId, productId: p.id }))).toBe(
        "ok",
      );
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("item 2b: the audit hash chain serialises on its head row: 20 concurrent writers leave one unbroken chain", async () => {
    const before = await pool.query<{ id: string }>("SELECT max(id)::text AS id FROM audit.audit_log");
    const writers = Array.from({ length: 20 }, (_, i) =>
      withTransaction(pool, async (c) => {
        await c.query(
          "SELECT audit.append_chained(NULL, 'SYSTEM', 'chain_test', 'writer', $1, NULL, $2::jsonb)",
          [String(i), JSON.stringify({ i })],
        );
        await new Promise((resolve) => setTimeout(resolve, 5)); // hold the head briefly
      }),
    );
    await Promise.all(writers);
    const { rows } = await pool.query<{
      id: string;
      actor_kind: string;
      action: string;
      target_type: string;
      target_id: string;
      reason: string | null;
      detail: unknown;
      prev: Buffer | null;
      hash: Buffer;
      canonical: string;
    }>(
      `SELECT id::text, prev_hash AS prev, row_hash AS hash,
              jsonb_build_object('actor_id', actor_id, 'actor_kind', actor_kind, 'action', action,
                'target_type', target_type, 'target_id', target_id, 'reason', reason, 'detail', detail,
                'created_at', created_at)::text AS canonical
         FROM audit.audit_log ORDER BY audit_log.id`,
    );
    const head = await pool.query<{ h: Buffer | null }>("SELECT row_hash AS h FROM audit.chain_head");
    const mine = rows.filter(
      (r) => before.rows[0]?.id === null || BigInt(r.id) > BigInt(before.rows[0]?.id ?? 0),
    );
    expect(mine.length).toBe(20);
    // every row links to the one before it and its hash recomputes
    let prev: Buffer | null =
      rows.length > mine.length ? (rows[rows.length - mine.length - 1]?.hash ?? null) : null;
    for (const r of mine) {
      expect(r.prev?.toString("hex") ?? null).toBe(prev?.toString("hex") ?? null);
      const expected = createHash("sha256")
        .update(Buffer.concat([prev ?? Buffer.alloc(0), Buffer.from(r.canonical, "utf8")]))
        .digest();
      expect(r.hash.toString("hex")).toBe(expected.toString("hex"));
      prev = r.hash;
    }
    expect(head.rows[0]?.h?.toString("hex")).toBe(prev?.toString("hex"));
    expect(new Set(mine.map((r) => r.prev?.toString("hex"))).size).toBe(20); // no fork
  });

  it("item 2c: the watchdog ends an application login (matched by membership, not by name) that holds an advisory lock idle outside any transaction while another backend waits for it", async () => {
    const login = `delulu_fifth_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    let attacker: pg.Client | null = null;
    let waiter: pg.PoolClient | null = null;
    try {
      await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE app_web`);
      // a platform where EXECUTE could not be revoked (a non-superuser owner): granted directly
      await pool.query(`GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO ${login}`);
      const url = new URL(db.url);
      url.username = login;
      url.password = password;
      attacker = new pg.Client({ connectionString: url.toString() });
      attacker.on("error", () => undefined); // the terminated connection reports here
      await attacker.connect();
      await attacker.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `core.cart_line:${victim.userId}`,
      ]);
      // sixth review: the watchdog ends only a backend that is idle in a transaction or keeps another
      // waiting, and never before five seconds; here another backend waits for the attacker's key
      waiter = await pool.connect();
      const waiting = waiter.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `core.cart_line:${victim.userId}`,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5_300));
      const killed = await withTransaction(
        pool,
        async (c) =>
          (
            await c.query<{ n: number }>(
              "SELECT ops.terminate_stuck_money_sessions(interval '1 second') AS n",
            )
          ).rows[0]?.n,
        { role: "app_jobs" },
      );
      expect(killed).toBe(1);
      await waiting; // the waiter gets the key once the attacker is gone
      expect(await codeOf(attacker.query("SELECT 1"))).not.toBe("ok");
      const audit = await pool.query<{ detail: { role: string } }>(
        `SELECT detail FROM audit.audit_log WHERE action = 'terminate_stuck_money_session' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit.rows[0]?.detail.role).toBe(login);
    } finally {
      await waiter?.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      waiter?.release();
      await attacker?.end().catch(() => undefined);
      await pool
        .query(`REVOKE EXECUTE ON FUNCTION pg_advisory_lock(bigint) FROM ${login}`)
        .catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
      await admin.end();
    }
  });

  it("item 2c: the watchdog leaves young sessions alone, and never the owner or a superuser", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(42)"); // the owner (a superuser here)
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const killed = await withTransaction(
        pool,
        async (c) =>
          (
            await c.query<{ n: number }>(
              "SELECT ops.terminate_stuck_money_sessions(interval '1 second') AS n",
            )
          ).rows[0]?.n,
        { role: "app_jobs" },
      );
      expect(killed).toBe(0);
      expect((await holder.query("SELECT 1 AS alive")).rows[0]).toEqual({ alive: 1 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
    }
  });
});

/** Fifth security review, item 4: rate limits are database counters (migration 0031). */
describe("fifth security review: database rate counters", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 10 });
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  const subject = () => randomBytes(32);

  it("item 4b: rate_hit counts hits per (scope, subject, window) and answers true up to max_hits", async () => {
    const who = subject();
    const answers: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      answers.push(
        await rateHit(pool, "app_web", { scope: "test.hits", subject: who, windowSeconds: 3600, maxHits: 3 }),
      );
    }
    expect(answers).toEqual([true, true, true, false, false]);
    // another subject and another scope have their own budgets
    expect(
      await rateHit(pool, "app_pay", {
        scope: "test.hits",
        subject: subject(),
        windowSeconds: 3600,
        maxHits: 3,
      }),
    ).toBe(true);
    expect(
      await rateHit(pool, "app_pay", { scope: "test.other", subject: who, windowSeconds: 3600, maxHits: 3 }),
    ).toBe(true);
    // a one-second window starts afresh
    const fast = subject();
    expect(
      await rateHit(pool, "app_web", { scope: "test.fast", subject: fast, windowSeconds: 1, maxHits: 1 }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(
      await rateHit(pool, "app_web", { scope: "test.fast", subject: fast, windowSeconds: 1, maxHits: 1 }),
    ).toBe(true);
  });

  it("item 4b: concurrent hits are all counted (no lost update)", async () => {
    const who = subject();
    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        rateHit(pool, "app_web", {
          scope: "test.concurrent",
          subject: who,
          windowSeconds: 3600,
          maxHits: 10,
        }),
      ),
    );
    expect(answers.filter(Boolean).length).toBe(10);
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count FROM core.rate_counter WHERE scope = 'test.concurrent' AND subject = $1",
      [who],
    );
    expect(rows[0]?.count).toBe(30);
  });

  it("item 4b: a hit is committed on its own, whatever happens to the caller's business transaction afterwards", async () => {
    const who = subject();
    await expect(
      withTransaction(pool, async () => {
        await rateHit(pool, "app_web", {
          scope: "test.rollback",
          subject: who,
          windowSeconds: 3600,
          maxHits: 5,
        });
        throw new Error("the business call failed");
      }),
    ).rejects.toThrow(/business call/);
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count FROM core.rate_counter WHERE scope = 'test.rollback' AND subject = $1",
      [who],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("item 4b: only app_web and app_pay may hit, only app_jobs may purge, nobody reads or writes the counters directly", async () => {
    const hit = "SELECT core.rate_hit('test.grants', $1, 60, 5)";
    for (const role of ["app_web", "app_pay"])
      expect(await stateOf(pool, hit, [subject()], { role }), role).toBe("no error");
    for (const role of ["app_jobs", "npc_worker", "research_ro"])
      expect(await stateOf(pool, hit, [subject()], { role }), role).toBe("42501");
    for (const role of ["app_web", "app_pay", "npc_worker", "research_ro"]) {
      expect(await stateOf(pool, "SELECT core.rate_purge()", [], { role }), role).toBe("42501");
    }
    expect(await stateOf(pool, "SELECT core.rate_purge()", [], { role: "app_jobs" })).toBe("no error");
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      for (const sql of [
        "SELECT 1 FROM core.rate_counter",
        "DELETE FROM core.rate_counter",
        "UPDATE core.rate_counter SET count = 1",
        "INSERT INTO core.rate_counter VALUES ('x', $1, now(), 1)",
      ]) {
        const params = sql.includes("$1") ? [subject()] : [];
        expect(await stateOf(pool, sql, params, { role }), `${role}: ${sql}`).toBe("42501");
      }
    }
  });

  it("item 4b: rate_hit refuses malformed input; rate_purge never removes a live window", async () => {
    for (const [scope, subj, win, max] of [
      ["Bad Scope", subject(), 60, 5],
      ["ok", randomBytes(16), 60, 5],
      ["ok", subject(), 0, 5],
      ["ok", subject(), 86_401, 5],
      ["ok", subject(), 60, 0],
    ] as const) {
      expect(
        await codeOf(rateHit(pool, "app_web", { scope, subject: subj, windowSeconds: win, maxHits: max })),
      ).toBe("VALIDATION_FAILED");
    }
    expect(
      await stateOf(pool, "SELECT core.rate_purge(interval '1 hour')", [], { role: "app_jobs" }),
    ).not.toBe("no error");
    const who = subject();
    await rateHit(pool, "app_web", { scope: "test.live", subject: who, windowSeconds: 86_400, maxHits: 5 });
    await pool.query("INSERT INTO core.rate_counter VALUES ('test.old', $1, now() - interval '3 days', 4)", [
      who,
    ]);
    const purged = await withTransaction(
      pool,
      async (c) => (await c.query<{ n: number }>("SELECT core.rate_purge() AS n")).rows[0]?.n,
      { role: "app_jobs" },
    );
    // the old window goes (sixth review: so does any other window that has already ended)
    expect(purged).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ scope: string }>(
      "SELECT scope FROM core.rate_counter WHERE subject = $1",
      [who],
    );
    expect(rows.map((r) => r.scope)).toEqual(["test.live"]);
  });
});
