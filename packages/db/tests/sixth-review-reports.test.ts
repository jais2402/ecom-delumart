import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminReports, createAppeal, createReport, resolveAppeal, resolveReportCase } from "../src/safety";
import { CLEAN, checkout, codeOf, count, payFor, reconcile, standard, user } from "./checkout-fixtures";
import { become, createTestDatabase, plant, type TestDatabase, type TestUser } from "./helpers";
import { type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const REASON = "Reviewed the reports and the listing.";
const STATEMENT = "This lamp is a fictional product and breaks no rule; please look again.";

/**
 * Sixth security review, major 1: report abuse (migration 0044). Each test names the rule it covers
 * and fails without it.
 */
describe("sixth security review: report standing and the automatic hide", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let c: Creator;
  let items: Awaited<ReturnType<typeof published>>;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    items = await published(pool, 3);
  }, 120_000);
  // a fresh store per test: a store has at most ten live listings
  beforeEach(async () => {
    c = await creator(pool, items);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  /** Dates the account's creation `hours` ago (as the auth service would have). */
  const age = (u: TestUser, hours: number) =>
    pool.query("UPDATE core.user_profile SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [
      u.userId,
      hours,
    ]);
  const aged = async (hours: number): Promise<TestUser> => {
    const u = await user(pool);
    await age(u, hours);
    return u;
  };
  /** An account old enough to be established on age alone (eight days). */
  const established = () => aged(8 * 24);
  /**
   * An account `hours` old with one completed platform purchase, four days old (since the seventh
   * review, 0054, a purchase counts towards "established" only once it is three days old).
   */
  const buyer = async (hours: number): Promise<TestUser> => {
    const u = await aged(hours);
    const [seed] = await published(pool, 1);
    if (!seed) throw new Error("no seed");
    await payFor(pool, u, await checkout(pool, u, [seed], standard("SEED")));
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.order_group SET created_at = created_at - interval '4 days' WHERE buyer_user_id = $1",
        [u.userId],
      ),
    );
    return u;
  };
  const report = (u: TestUser, productId: string) =>
    createReport(pool, { ...as(u), targetType: "PRODUCT", targetId: productId, reason: "SCAM_OR_PAYMENT" });
  const status = async (productId: string) =>
    (await pool.query<{ status: string }>("SELECT status FROM core.product WHERE id = $1", [productId]))
      .rows[0]?.status;
  const openCase = async (productId: string) =>
    (
      await pool.query<{ id: string }>(
        "SELECT id FROM core.report_case WHERE product_id = $1 AND status = 'OPEN'",
        [productId],
      )
    ).rows[0]?.id ?? "";
  const qualifying = async (caseId: string) =>
    Number(
      (await pool.query<{ n: number }>("SELECT core.report_qualifying_count($1) AS n", [caseId])).rows[0]?.n,
    );
  const hideBy = async (productId: string, reporters: TestUser[]) => {
    for (const r of reporters) await report(r, productId);
    expect(await status(productId)).toBe("HIDDEN");
  };

  it("(a) reviewer's sequence: young accounts that report and then age past 24 hours never count — age is judged at the time of the report", async () => {
    const l = await publishListing(pool, c);
    // three accounts an hour old, each with a completed purchase (established, but too young)
    const young = [await buyer(1), await buyer(1), await buyer(1)];
    for (const r of young) await report(r, l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    const { rows } = await pool.query<{ reporter_aged: boolean }>(
      "SELECT reporter_aged FROM core.report WHERE case_id = $1",
      [await openCase(l.productId)],
    );
    expect(rows.map((r) => r.reporter_aged)).toEqual([false, false, false]);
    // they age into the old rule's window ...
    for (const r of young) await age(r, 10 * 24);
    // ... and a fourth, qualifying report does not complete a hide with them
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    expect(await qualifying(await openCase(l.productId))).toBe(1);
  });

  it("(b) reviewer's sequence: after an appeal against the hide is upheld, the same three cannot report again for 90 days and the product is exempt from automatic hiding for 30 days", async () => {
    const l = await publishListing(pool, c);
    const three = [await established(), await established(), await established()];
    await hideBy(l.productId, three);
    const appeal = await createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT });
    await resolveAppeal(pool, { ...as(admin), appealId: appeal.appealId, outcome: "UPHELD", reason: REASON });
    expect(await status(l.productId)).toBe("PUBLISHED");

    // the same three re-report: refused, as already reported
    for (const r of three) expect(await codeOf(report(r, l.productId))).toBe("ALREADY_REPORTED");
    // three fresh, qualifying reporters: the case opens for the Super Admin, nothing is hidden
    const fresh = [await established(), await established(), await established()];
    for (const r of fresh) expect(await codeOf(report(r, l.productId))).toBe("ok");
    expect(await status(l.productId)).toBe("PUBLISHED");
    const page = await adminReports(pool, { ...as(admin), pageSize: 50 });
    const item = page.items.find(
      (i) => (i.target as { productId?: string } | null)?.productId === l.productId,
    );
    expect(item).toMatchObject({ status: "OPEN", reporterCount: 3, autoHidden: false });

    // 31 days later the exemption has run out: the next qualifying report hides it again
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.report_clearance SET cleared_at = cleared_at - interval '31 days' WHERE product_id = $1",
        [l.productId],
      ),
    );
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("(b) the 90-day block on the cleared case's reporters ends after 90 days", async () => {
    const l = await publishListing(pool, c);
    const r = await established();
    await report(r, l.productId);
    await resolveReportCase(pool, {
      ...as(admin),
      caseId: await openCase(l.productId),
      outcome: "DISMISSED",
      reason: REASON,
    });
    expect(await codeOf(report(r, l.productId))).toBe("ALREADY_REPORTED");
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.report_clearance SET cleared_at = cleared_at - interval '89 days' WHERE product_id = $1",
        [l.productId],
      ),
    );
    expect(await codeOf(report(r, l.productId))).toBe("ALREADY_REPORTED");
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.report_clearance SET cleared_at = cleared_at - interval '2 days' WHERE product_id = $1",
        [l.productId],
      ),
    );
    expect(await codeOf(report(r, l.productId))).toBe("ok");
  });

  it("(b) after a DISMISSED case the reporters cannot re-report and the product is exempt from the automatic hide", async () => {
    const l = await publishListing(pool, c);
    const three = [await established(), await established(), await established()];
    await hideBy(l.productId, three);
    const dismissed = await resolveReportCase(pool, {
      ...as(admin),
      caseId: await openCase(l.productId),
      outcome: "DISMISSED",
      reason: REASON,
    });
    expect(dismissed).toMatchObject({ effect: "RESTORED", productStatus: "PUBLISHED" });
    for (const r of three) expect(await codeOf(report(r, l.productId))).toBe("ALREADY_REPORTED");
    for (let i = 0; i < 4; i++) await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    expect(await qualifying(await openCase(l.productId))).toBe(4);
  });

  it("(c) a reporter with two dismissed reports in the last 30 days may report, but the report does not count", async () => {
    const x = await established();
    for (let i = 0; i < 2; i++) {
      const other = await publishListing(pool, c);
      await report(x, other.productId);
      await resolveReportCase(pool, {
        ...as(admin),
        caseId: await openCase(other.productId),
        outcome: "DISMISSED",
        reason: REASON,
      });
    }
    const l = await publishListing(pool, c);
    expect(await codeOf(report(x, l.productId))).toBe("ok");
    await report(await established(), l.productId);
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    expect(await qualifying(await openCase(l.productId))).toBe(2);
    const { rows } = await pool.query<{ reporter_in_standing: boolean }>(
      "SELECT reporter_in_standing FROM core.report WHERE reporter_user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [x.userId],
    );
    expect(rows[0]?.reporter_in_standing).toBe(false);
    // standing is kept as it was at the time of the report: the dismissals ageing out later does
    // not make this report count
    await plant(pool, (q) =>
      q.query(
        `UPDATE core.report_clearance SET cleared_at = cleared_at - interval '31 days'
          WHERE case_id IN (SELECT case_id FROM core.report WHERE reporter_user_id = $1)`,
        [x.userId],
      ),
    );
    expect(await qualifying(await openCase(l.productId))).toBe(2);
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("(c) standing is also checked when the hide is evaluated: dismissals after the report take it away", async () => {
    const l = await publishListing(pool, c);
    const x = await established();
    await report(x, l.productId);
    await report(await established(), l.productId);
    expect(await qualifying(await openCase(l.productId))).toBe(2);
    for (let i = 0; i < 2; i++) {
      const other = await publishListing(pool, c);
      await report(x, other.productId);
      await resolveReportCase(pool, {
        ...as(admin),
        caseId: await openCase(other.productId),
        outcome: "DISMISSED",
        reason: REASON,
      });
    }
    expect(await qualifying(await openCase(l.productId))).toBe(1);
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
  });

  it("(d) a reporter's reports contribute to at most one automatic hide per rolling 24 hours, across products", async () => {
    const a = await publishListing(pool, c);
    const b = await publishListing(pool, c);
    const three = [await established(), await established(), await established()];
    await hideBy(a.productId, three);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM core.auto_hide_contribution WHERE reporter_user_id = ANY($1)",
        [three.map((r) => r.userId)],
      ),
    ).toBe(3);
    for (const r of three) await report(r, b.productId);
    expect(await status(b.productId)).toBe("PUBLISHED");
    expect(await qualifying(await openCase(b.productId))).toBe(0);
    // a day later they count again
    await plant(pool, (x) =>
      x.query(
        "UPDATE core.auto_hide_contribution SET created_at = created_at - interval '25 hours' WHERE reporter_user_id = ANY($1)",
        [three.map((r) => r.userId)],
      ),
    );
    await report(await established(), b.productId);
    expect(await status(b.productId)).toBe("HIDDEN");
  });

  it("(d) concurrent hides on two products sharing reporters: only one completes", async () => {
    const x = await publishListing(pool, c);
    const y = await publishListing(pool, c);
    const shared = [await established(), await established()];
    for (const r of shared) {
      await report(r, x.productId);
      await report(r, y.productId);
    }
    const [r3, r4] = [await established(), await established()];
    // r3's report hides x in a transaction that has not committed yet ...
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await become(held, { role: "app_pay", userId: r3.userId });
      await held.query("SELECT core.report_create('PRODUCT', $1, 'SCAM_OR_PAYMENT', NULL, '[]'::jsonb)", [
        x.productId,
      ]);
      // ... while r4's report on y runs: it waits for the shared reporters, then sees them spent
      const second = report(r4, y.productId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await held.query("COMMIT");
      expect(await codeOf(second)).toBe("ok");
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
    }
    expect(await status(x.productId)).toBe("HIDDEN");
    expect(await status(y.productId)).toBe("PUBLISHED");
  });

  it("(e) three qualifying reporters each need a completed purchase or an account at least 7 days old", async () => {
    const l = await publishListing(pool, c);
    // 48 hours old, no purchase: old enough to be counted under (a), but not established
    for (let i = 0; i < 3; i++) await report(await aged(48), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    expect(await qualifying(await openCase(l.productId))).toBe(0);
    // a 48-hour-old buyer and two week-old accounts do
    const m = await publishListing(pool, c);
    await report(await buyer(48), m.productId);
    await report(await aged(7 * 24 + 1), m.productId);
    expect(await status(m.productId)).toBe("PUBLISHED");
    await report(await aged(7 * 24 + 1), m.productId);
    expect(await status(m.productId)).toBe("HIDDEN");
  });

  it("major 4: while publication is off, a dismissed case and an upheld appeal still restore the listing", async () => {
    const [a, b] = [await publishListing(pool, c), await publishListing(pool, c)];
    await hideBy(a.productId, [await established(), await established(), await established()]);
    await hideBy(b.productId, [await established(), await established(), await established()]);
    const appeal = await createAppeal(pool, { ...as(c.u), productId: b.productId, statement: STATEMENT });
    await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'publication'");
    try {
      expect(
        await resolveReportCase(pool, {
          ...as(admin),
          caseId: await openCase(a.productId),
          outcome: "DISMISSED",
          reason: REASON,
        }),
      ).toMatchObject({ effect: "RESTORED", productStatus: "PUBLISHED" });
      expect(
        await resolveAppeal(pool, {
          ...as(admin),
          appealId: appeal.appealId,
          outcome: "UPHELD",
          reason: REASON,
        }),
      ).toMatchObject({ effect: "RESTORED", productStatus: "PUBLISHED" });
    } finally {
      await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'publication'");
    }
  });
});
