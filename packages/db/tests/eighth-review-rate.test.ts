import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeRateCounters } from "../src/jobs";
import { rateHit } from "../src/rate";
import { countRows, createTestDatabase, type TestDatabase } from "./helpers";

/**
 * Eighth security review, minor 8b (migration 0062): over `rate_counter_max_rows`, a hit for a NEW
 * subject fails closed with the normal rate-limited answer and stores nothing; subjects the table
 * already holds continue; one SYSTEM audit row per hour records it. Live windows are still never
 * evicted (0057).
 */
describe("eighth security review: the rate counter's insert guard", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const setCap = (cap: number | null) =>
    pool.query(
      `UPDATE core.config_version SET values = CASE WHEN $1::int IS NULL THEN values - 'rate_counter_max_rows'
                                                     ELSE values || jsonb_build_object('rate_counter_max_rows', $1::int) END
        WHERE id = core.current_config_id()`,
      [cap],
    );
  const overCapRows = () =>
    countRows(
      pool,
      "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'rate.over_cap' AND actor_kind = 'SYSTEM'",
    );
  const subject = (label: string) => createHash("sha256").update(label).digest();
  const hit = (label: string, maxHits = 5) =>
    rateHit(pool, "app_web", { scope: "test.guard", subject: subject(label), windowSeconds: 60, maxHits });

  /** Waits until the statistics system has seen at least `n` live rows (it flushes about every second). */
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

  it("minor 8b: over the cap, a new subject is refused and stores nothing; an existing subject continues; one audit row an hour", async () => {
    await pool.query("DELETE FROM core.rate_counter");
    // two subjects already counted, under the cap
    expect(await hit("known-1")).toBe(true);
    expect(await hit("known-2")).toBe(true);
    await setCap(20);
    try {
      await pool.query(
        `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
         SELECT 'test.live', sha256(int4send(g)), now(), 1, 86400 FROM generate_series(1, 25) g`,
      );
      await statsSee(27);
      const before = await overCapRows();
      const rows = await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter");
      for (let i = 0; i < 5; i++) expect(await hit(`newcomer-${i}`), `newcomer-${i}`).toBe(false);
      expect(await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter")).toBe(rows);
      // a subject the table already holds keeps its normal limit
      expect(await hit("known-1")).toBe(true);
      expect(await hit("known-2")).toBe(true);
      // one SYSTEM row for the hour, however many were refused (the purge in the same hour adds none)
      expect(await overCapRows()).toBe(before + 1);
      await purgeRateCounters(pool);
      expect(await overCapRows()).toBe(before + 1);
      // live windows are still never evicted
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'test.live'"),
      ).toBe(25);
    } finally {
      await setCap(null);
      await pool.query("DELETE FROM core.rate_counter WHERE scope = 'test.live'");
    }
    // under the cap again, newcomers are counted
    expect(await hit(`newcomer-${randomBytes(4).toString("hex")}`)).toBe(true);
  });

  it("minor 8b: the guard's alert table is the owner's alone", async () => {
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      const { rows } = await pool.query<{ ok: boolean }>(
        "SELECT has_table_privilege($1, 'core.rate_cap_alert', 'SELECT') AS ok",
        [role],
      );
      expect(rows[0]?.ok, role).toBe(false);
    }
  });
});
