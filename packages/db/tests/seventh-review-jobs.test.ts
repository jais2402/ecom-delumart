import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { moderationSafetyNet, purgeRateCounters } from "../src/jobs";
import { adminStatus, createDraft, submitProduct } from "../src/listing";
import { user } from "./checkout-fixtures";
import { countRows, createTestDatabase, plant, type TestDatabase, type TestUser } from "./helpers";
import { creator, draftInput, ensureCategories } from "./listing-fixtures";
import { published } from "./selling-fixtures";

/**
 * Seventh security review, minors 5b (stalled screening is overdue again), 7b (the rate counter cap
 * never evicts a live window) and 7c (no leftover allow-all policies for app_jobs); migration 0057.
 */
describe("seventh security review: moderation overdue, rate counters and app_jobs policies", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  // ------------------------------------------------------------------ 5b
  it("minor 5b: a submission stuck in SCREENING beyond the threshold is overdue again, reported separately; the existing fields stay", async () => {
    const c = await creator(pool, await published(pool, 3));
    const d = await createDraft(pool, { authSessionId: c.u.authSessionId, draft: draftInput() });
    await submitProduct(pool, { authSessionId: c.u.authSessionId, productId: d.productId });
    const state = await pool.query<{ state: string }>(
      "SELECT state FROM core.listing_submission WHERE product_id = $1",
      [d.productId],
    );
    expect(state.rows[0]?.state).toBe("SCREENING");
    const before = await adminStatus(pool, { authSessionId: admin.authSessionId });
    expect(before.screeningStalled.count).toBe(0);
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.listing_submission SET submitted_at = now() - interval '49 hours' WHERE product_id = $1",
        [d.productId],
      ),
    );
    const s = await adminStatus(pool, { authSessionId: admin.authSessionId });
    expect(s.screeningStalled.count).toBe(1);
    expect(s.screeningStalled.oldestAgeSeconds).toBeGreaterThanOrEqual(49 * 3600);
    expect(s.screeningStalled.thresholdHours).toBe(48);
    // the review queue's overdue figures are unchanged (nothing waits for review)
    expect(s.moderationOverdue).toMatchObject({ count: 0, oldestAgeSeconds: null, thresholdHours: 48 });
    // the safety net counts it and audits it (once per UTC day), without touching the switch
    const audits = () =>
      countRows(
        pool,
        "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'moderation.overdue' AND actor_kind = 'SYSTEM'",
      );
    const n = await audits();
    const net = await moderationSafetyNet(pool);
    expect(net).toMatchObject({ overdue: true });
    expect(net.count).toBeGreaterThanOrEqual(1);
    expect((await audits()) - n).toBeLessThanOrEqual(1);
    expect(await audits()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ enabled: boolean }>(
      "SELECT enabled FROM core.system_switch WHERE name = 'publication'",
    );
    expect(rows[0]?.enabled).toBe(true);
  });

  // ------------------------------------------------------------------ 7b
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

  it("minor 7b: over the cap, the purge evicts only ended windows, never a live one, and records the overflow once per hour", async () => {
    await pool.query("DELETE FROM core.rate_counter");
    await setCap(10);
    try {
      // 15 live windows (a day long, started now) and 5 that have ended
      await pool.query(
        `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
         SELECT 'test.live', sha256(int4send(g)), now() - make_interval(secs => g), 1, 86400 FROM generate_series(1, 15) g`,
      );
      await pool.query(
        `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
         SELECT 'test.ended', sha256(int4send(g)), now() - interval '2 minutes', 1, 60 FROM generate_series(1, 5) g`,
      );
      const before = await overCapRows();
      expect(await purgeRateCounters(pool)).toBe(5);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'test.live'"),
      ).toBe(15);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'test.ended'"),
      ).toBe(0);
      expect(await overCapRows()).toBe(before + 1);
      // the same hour: nothing more is evicted, and no second row
      expect(await purgeRateCounters(pool)).toBe(0);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.rate_counter WHERE scope = 'test.live'"),
      ).toBe(15);
      expect(await overCapRows()).toBe(before + 1);
      const { rows } = await pool.query(
        "SELECT actor_id, actor_kind FROM audit.audit_log WHERE action = 'rate.over_cap' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0]).toEqual({ actor_id: null, actor_kind: "SYSTEM" });
    } finally {
      await setCap(null);
      await pool.query("DELETE FROM core.rate_counter WHERE scope IN ('test.live', 'test.ended')");
    }
  });

  it("minor 7b: under the cap nothing is recorded", async () => {
    const before = await overCapRows();
    await pool.query(
      `INSERT INTO core.rate_counter (scope, subject, window_start, count, window_seconds)
       VALUES ('test.one', $1, now(), 1, 86400)`,
      [randomBytes(32)],
    );
    await purgeRateCounters(pool);
    expect(await overCapRows()).toBe(before);
    await pool.query("DELETE FROM core.rate_counter WHERE scope = 'test.one'");
  });

  // ------------------------------------------------------------------ 7c
  it("minor 7c: no policy lets app_jobs see or write every row (the leftover jobs_all policies are gone)", async () => {
    const { rows } = await pool.query<{ t: string; p: string }>(
      `SELECT schemaname || '.' || tablename AS t, policyname AS p FROM pg_policies
        WHERE policyname = 'jobs_all' OR ('app_jobs' = ANY (roles) AND (qual = 'true' OR with_check = 'true'))
        ORDER BY 1`,
    );
    expect(rows).toEqual([]);
  });
});
