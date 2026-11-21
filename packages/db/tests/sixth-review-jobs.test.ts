import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptJobsRequest,
  moderationSafetyNet,
  pendingScreenings,
  purgeIdempotencyRecords,
  purgeRateCounters,
  terminateStuckMoneySessions,
} from "../src/jobs";
import { rateHit } from "../src/rate";
import { withTransaction } from "../src/transaction";
import { codeOf, merchantCoupon, seller, user } from "./checkout-fixtures";
import { ADMIN_URL, createTestDatabase, stateOf, type TestDatabase } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sixth security review, major 3: the app_jobs credential (migration 0047). app_jobs holds no
 * direct table privilege; the jobs run only through their definer functions; the watchdog has a
 * floor and terminates only idle-in-transaction backends and lock-wait blockers.
 */
describe("sixth security review: the jobs credential", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  const logins: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
  }, 120_000);
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      for (const login of logins) await admin.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    } finally {
      await admin.end();
    }
    await db.drop();
  });

  /** A fresh LOGIN that is a member of `role`, connected to the test database. */
  async function loginAs(role: string): Promise<pg.Client> {
    const login = `delulu_sixth_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE ${role}`);
    } finally {
      await admin.end();
    }
    logins.push(login);
    const url = new URL(db.url);
    url.username = login;
    url.password = password;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on("error", () => undefined); // a terminated connection reports here
    await client.connect();
    return client;
  }
  const watchdog = (maxAge: string) =>
    withTransaction(
      pool,
      async (c) =>
        Number(
          (
            await c.query<{ n: number }>("SELECT ops.terminate_stuck_money_sessions($1::interval) AS n", [
              maxAge,
            ])
          ).rows[0]?.n,
        ),
      { role: "app_jobs" },
    );
  const alive = async (c: pg.Client) => {
    try {
      await c.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Tables app_jobs may SELECT, each with the reason. Empty: every job reads through its definer
   * function. Adding a table here needs a reason, and never a table of personal or money data.
   */
  const SELECT_EXCEPTIONS: Readonly<Record<string, string>> = {};

  it("major 3 (generated): for every table of the application schemas, app_jobs holds no INSERT, UPDATE, DELETE, TRUNCATE or SELECT (table or column), except the listed ones", async () => {
    const { rows: tables } = await pool.query<{ t: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('core', 'ledger', 'private', 'sandbox', 'analytics', 'audit', 'research', 'ops', 'auth')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY 1`,
    );
    expect(tables.length).toBeGreaterThan(50);
    const { rows: held } = await pool.query<{ t: string; p: string }>(
      `SELECT t, p FROM unnest($1::text[]) t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
        WHERE CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege('app_jobs', t, p)
                   ELSE has_table_privilege('app_jobs', t, p) END
        ORDER BY 1, 2`,
      [tables.map((r) => r.t)],
    );
    expect(held.filter((h) => !(h.p === "SELECT" && h.t in SELECT_EXCEPTIONS))).toEqual([]);
    // and no sequence
    const { rows: seqs } = await pool.query<{ s: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND (has_sequence_privilege('app_jobs', c.oid, 'USAGE') OR has_sequence_privilege('app_jobs', c.oid, 'UPDATE'))`,
    );
    expect(seqs).toEqual([]);
  });

  it("major 3: the reviewer's attacks as app_jobs — a coupon at 90% off, a suspended Super Admin, fingerprints and bank aliases — are refused", async () => {
    const s = await seller(pool);
    const coupon = await merchantCoupon(pool, s, { percent: 10 });
    const admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    const jobs = { role: "app_jobs" };
    for (const sql of [
      `UPDATE core.coupon SET value = 90 WHERE id = '${coupon.id}'`,
      `UPDATE core.user_profile SET status = 'SUSPENDED' WHERE id = '${admin.userId}'`,
      "SELECT email_fingerprint, phone_fingerprint FROM core.user_profile",
      "SELECT alias FROM core.bank_account",
      "SELECT * FROM core.identity_tombstone",
      "SELECT * FROM ledger.posting",
      "UPDATE core.promo_campaign SET budget_paise = 1",
      "INSERT INTO audit.audit_log (actor_kind, action, row_hash) VALUES ('SYSTEM', 'x', '\\x00')",
      "UPDATE core.company SET name = 'Taken over'",
    ]) {
      expect(await stateOf(pool, sql, [], jobs), sql).toBe("42501");
    }
    const { rows } = await pool.query<{ value: string; status: string }>(
      "SELECT c.value::text AS value, (SELECT status FROM core.user_profile WHERE id = $2) AS status FROM core.coupon c WHERE c.id = $1",
      [coupon.id, admin.userId],
    );
    expect(rows[0]).toEqual({ value: "10", status: "ACTIVE" });
  });

  it("major 3: the jobs still run, as app_jobs, through their functions", async () => {
    expect(Array.isArray(await pendingScreenings(pool, 10))).toBe(true);
    expect(await moderationSafetyNet(pool)).toMatchObject({ overdue: false });
    expect(typeof (await purgeRateCounters(pool))).toBe("number");
    expect(typeof (await purgeIdempotencyRecords(pool))).toBe("number");
    expect(typeof (await terminateStuckMoneySessions(pool))).toBe("number");
  });

  it("major 3: the watchdog never ends a working transaction that blocks nobody, whatever max_age it is given", async () => {
    const worker = await loginAs("app_web");
    try {
      await worker.query("BEGIN");
      await worker.query("LOCK TABLE analytics.experiment_exposure IN ROW EXCLUSIVE MODE");
      const working = worker.query("SELECT pg_sleep(7)");
      await sleep(6_000);
      expect(await watchdog("1 second")).toBe(0);
      await working;
      expect(await alive(worker)).toBe(true);
      await worker.query("ROLLBACK");
    } finally {
      await worker.end().catch(() => undefined);
    }
  });

  it("major 3: a max_age below 5 seconds is ignored; an idle-in-transaction lock holder is ended after 5", async () => {
    const idle = await loginAs("app_web");
    try {
      await idle.query("BEGIN");
      await idle.query("LOCK TABLE analytics.experiment_exposure IN ROW EXCLUSIVE MODE");
      await sleep(2_000);
      expect(await watchdog("1 second")).toBe(0);
      expect(await alive(idle)).toBe(true); // a statement: idle again from now
      await sleep(5_500);
      expect(await watchdog("1 second")).toBe(1);
      expect(await alive(idle)).toBe(false);
      const { rows } = await pool.query<{ detail: { maxAgeSeconds: number } }>(
        "SELECT detail FROM audit.audit_log WHERE action = 'terminate_stuck_money_session' ORDER BY id DESC LIMIT 1",
      );
      expect(Number(rows[0]?.detail.maxAgeSeconds)).toBe(5);
    } finally {
      await idle.end().catch(() => undefined);
    }
  });

  it("major 3: a working transaction that keeps another backend waiting beyond 5 seconds is ended", async () => {
    const blocker = await loginAs("app_web");
    const waiter = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE analytics.experiment_exposure IN ROW EXCLUSIVE MODE");
      const working = blocker.query("SELECT pg_sleep(30)").catch(() => "ended");
      await waiter.query("BEGIN");
      await waiter.query("SET LOCAL lock_timeout = '20s'");
      const waiting = waiter.query("LOCK TABLE analytics.experiment_exposure IN ACCESS EXCLUSIVE MODE");
      await sleep(5_500);
      expect(await watchdog("1 second")).toBe(1);
      await waiting; // the waiter gets its lock
      expect(await working).toBe("ended");
    } finally {
      await waiter.query("ROLLBACK").catch(() => undefined);
      waiter.release();
      await blocker.end().catch(() => undefined);
    }
  });

  // ------------------------------------------------------------------ minor 9
  it("minor 9: a signed jobs request is accepted once; a replay within the window is refused; old entries are purged", async () => {
    const hash = createHash("sha256").update(randomBytes(32)).digest();
    const now = new Date();
    expect(await acceptJobsRequest(pool, { signatureHash: hash, requestAt: now })).toBe(true);
    expect(await acceptJobsRequest(pool, { signatureHash: hash, requestAt: now })).toBe(false);
    const other = createHash("sha256").update(randomBytes(32)).digest();
    expect(await acceptJobsRequest(pool, { signatureHash: other, requestAt: now })).toBe(true);
    // a signed time outside the window is refused outright
    expect(
      await codeOf(
        acceptJobsRequest(pool, {
          signatureHash: randomBytes(32),
          requestAt: new Date(Date.now() - 10 * 60_000),
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    // entries older than two minutes go on the next call
    await pool.query(
      "UPDATE core.jobs_request_seen SET seen_at = seen_at - interval '3 minutes', request_at = request_at - interval '3 minutes' WHERE signature_hash = $1",
      [hash],
    );
    await acceptJobsRequest(pool, { signatureHash: randomBytes(32), requestAt: now });
    expect(
      (await pool.query("SELECT 1 FROM core.jobs_request_seen WHERE signature_hash = $1", [hash])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM core.jobs_request_seen WHERE signature_hash = $1", [other])).rowCount,
    ).toBe(1);
    // only the jobs login records requests; nobody reads the table
    for (const role of ["app_web", "app_pay", "npc_worker", "research_ro"]) {
      expect(
        await stateOf(pool, "SELECT core.jobs_accept_request($1, now())", [randomBytes(32)], { role }),
        role,
      ).toBe("42501");
    }
    for (const role of ["app_web", "app_pay", "app_jobs"]) {
      expect(await stateOf(pool, "SELECT * FROM core.jobs_request_seen", [], { role }), role).toBe("42501");
    }
  });

  // ------------------------------------------------------------------ minor 10
  it("minor 10: every job run purges windows that have ended, and leaves live ones", async () => {
    const who = randomBytes(32);
    await rateHit(pool, "app_web", { scope: "test.short", subject: who, windowSeconds: 1, maxHits: 5 });
    await rateHit(pool, "app_web", { scope: "test.daily", subject: who, windowSeconds: 86_400, maxHits: 5 });
    await sleep(1_100);
    expect(await purgeRateCounters(pool)).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ scope: string }>(
      "SELECT scope FROM core.rate_counter WHERE subject = $1",
      [who],
    );
    expect(rows.map((r) => r.scope)).toEqual(["test.daily"]);
  });

  // Seventh review (7b, 0057): the cap used to evict the oldest windows even while they were live,
  // which reset a counter an attacker could fill; over the cap the purge now evicts nothing live and
  // records the overflow instead (tests/seventh-review-jobs.test.ts covers the audit row).
  it("minor 10: over the row limit the purge keeps every live window (seventh review: none is evicted)", async () => {
    await pool.query(
      `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
       SELECT 'test.flood', sha256(int4send(g)), now() - make_interval(secs => g * 0.1), 1, 86400
         FROM generate_series(1, 200010) g`,
    );
    try {
      await purgeRateCounters(pool);
      expect(
        Number(
          (
            await pool.query<{ n: string }>(
              "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'test.flood'",
            )
          ).rows[0]?.n,
        ),
      ).toBe(200_010);
      expect(
        (await pool.query("SELECT 1 FROM core.rate_counter WHERE subject = sha256(int4send(200010))"))
          .rowCount,
      ).toBe(1);
    } finally {
      await pool.query("DELETE FROM core.rate_counter WHERE scope = 'test.flood'");
    }
  });
});
