import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rateHit } from "../src/rate";
import { countRows, createTestDatabase, type TestDatabase } from "./helpers";

/**
 * Ninth security review, major 2c (migration 0076): filling core.rate_counter cannot shut sign-in
 * down. Over the soft cap the oldest address subjects seen once are evicted to make room; with
 * nothing evictable, sign-in and payment scopes are still counted up to a higher hard cap; one
 * IPv6 /48 cannot create subjects without bound.
 */
describe("ninth review, major 2c: rate counter headroom", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const setConfig = (values: Record<string, number | null>) =>
    pool.query(
      `UPDATE core.config_version
          SET values = (SELECT jsonb_strip_nulls(values || $1::jsonb))
        WHERE id = core.current_config_id()`,
      [JSON.stringify(values)],
    );
  const digest = (label: string) => createHash("sha256").update(label).digest();
  const hit = (scope: string, label: string, net: Buffer | null = null) =>
    rateHit(pool, "app_web", { scope, subject: digest(label), windowSeconds: 3600, maxHits: 5, net });

  async function statsSee(n: number): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query("SELECT pg_stat_force_next_flush()");
    } finally {
      c.release();
    }
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT pg_stat_get_live_tuples('core.rate_counter'::regclass)::text AS n",
      );
      if (Number(rows[0]?.n) >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("statistics did not catch up");
  }

  /** Fills the table to `n` live rows of `scope`, each counted `count` times, started `agoMinutes` ago. */
  const fill = (scope: string, n: number, count: number, agoMinutes: number) =>
    pool.query(
      `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
       SELECT $1, sha256(convert_to($1 || g::text, 'UTF8')), date_trunc('minute', now()) - make_interval(mins => $4), $3, 86400
         FROM generate_series(1, $2) g`,
      [scope, n, count, agoMinutes],
    );

  it("major 2c: over the soft cap, the oldest address subjects seen once are evicted and a new sign-in subject is counted", async () => {
    await pool.query("DELETE FROM core.rate_counter");
    await setConfig({ rate_counter_max_rows: 30, rate_counter_evict_batch: 4 });
    try {
      await fill("auth.sign_in.address", 10, 1, 30); // cheapest, oldest
      await fill("auth.sign_in.address", 10, 1, 5); // cheapest, newer
      await fill("auth.sign_in.address", 15, 3, 60); // seen more than once: kept
      await statsSee(35);
      expect(await hit("auth.sign_in.email", "victim@example.test")).toBe(true);
      const left = await pool.query<{ ago: number; n: string }>(
        `SELECT round(extract(epoch FROM date_trunc('minute', now()) - window_start) / 60)::int AS ago, count(*) AS n
           FROM core.rate_counter WHERE scope = 'auth.sign_in.address' AND count = 1 GROUP BY 1 ORDER BY 1`,
      );
      expect(left.rows.map((r) => [r.ago, Number(r.n)])).toEqual([
        [5, 10],
        [30, 6],
      ]);
      expect(
        await countRows(
          pool,
          "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'auth.sign_in.address' AND count = 3",
        ),
      ).toBe(15);
    } finally {
      await setConfig({ rate_counter_max_rows: null, rate_counter_evict_batch: null });
      await pool.query("DELETE FROM core.rate_counter");
    }
  });

  it("major 2c: nothing evictable: sign-in and payment scopes are still counted below the hard cap, other new subjects are refused; over the hard cap all new subjects are", async () => {
    await pool.query("DELETE FROM core.rate_counter");
    await setConfig({ rate_counter_max_rows: 20, rate_counter_hard_max_rows: 40 });
    try {
      await fill("studio.write.actor", 25, 2, 1);
      await statsSee(25);
      expect(await hit("auth.sign_in.email", `a-${randomBytes(4).toString("hex")}`)).toBe(true);
      expect(await hit("checkout.pay.actor", `p-${randomBytes(4).toString("hex")}`)).toBe(true);
      expect(await hit("studio.write.actor", `s-${randomBytes(4).toString("hex")}`)).toBe(false);
      await fill("cart.write.actor", 20, 2, 1);
      await statsSee(45);
      expect(await hit("auth.sign_in.email", `b-${randomBytes(4).toString("hex")}`)).toBe(false);
      // one SYSTEM audit row for the hour while over the soft cap
      expect(
        await countRows(
          pool,
          "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'rate.over_cap' AND actor_kind = 'SYSTEM' AND created_at >= date_trunc('hour', now())",
        ),
      ).toBe(1);
    } finally {
      await setConfig({ rate_counter_max_rows: null, rate_counter_hard_max_rows: null });
      await pool.query("DELETE FROM core.rate_counter");
    }
  });

  it("major 2c: one IPv6 /48 creates at most `rate_counter_subjects_per_net` live subjects; known subjects and other networks continue", async () => {
    await pool.query("DELETE FROM core.rate_counter");
    await setConfig({ rate_counter_subjects_per_net: 3 });
    try {
      const net = digest("2001:db8:1::/48");
      for (let i = 0; i < 3; i++) expect(await hit("auth.sign_in.address", `net-${i}`, net)).toBe(true);
      expect(await hit("auth.sign_in.address", "net-3", net)).toBe(false);
      expect(await hit("auth.sign_in.address", "net-0", net)).toBe(true); // known
      expect(await hit("auth.sign_in.address", "other", digest("2001:db8:2::/48"))).toBe(true);
      expect(await hit("auth.sign_in.address", "v4", null)).toBe(true);
    } finally {
      await setConfig({ rate_counter_subjects_per_net: null });
      await pool.query("DELETE FROM core.rate_counter");
    }
  });
});
