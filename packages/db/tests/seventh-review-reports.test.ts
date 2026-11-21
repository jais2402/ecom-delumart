import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviseProduct } from "../src/listing";
import { createAppeal, createReport, resolveAppeal, resolveReportCase } from "../src/safety";
import { CLEAN, checkout, codeOf, payFor, reconcile, standard, user } from "./checkout-fixtures";
import {
  become,
  createTestDatabase,
  inRolledBackTx,
  plant,
  type TestDatabase,
  type TestUser,
} from "./helpers";
import {
  asFixture,
  type Creator,
  creator,
  ensureCategories,
  publishListing,
  screen,
} from "./listing-fixtures";
import { published } from "./selling-fixtures";

const REASON = "Reviewed the reports and the listing.";
const STATEMENT = "This lamp is a fictional product and breaks no rule; please look again.";

/**
 * Seventh security review, major 2 (the automatic-hide exemption) and minor 6 (the "established"
 * bar), migration 0054.
 */
describe("seventh security review: report clearances and established reporters", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let c: Creator;
  let seeds: Awaited<ReturnType<typeof published>>;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
    seeds = await published(pool, 3);
  }, 120_000);
  beforeEach(async () => {
    c = await creator(pool, seeds);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  const aged = async (hours: number): Promise<TestUser> => {
    const u = await user(pool);
    await pool.query(
      "UPDATE core.user_profile SET created_at = now() - make_interval(hours => $2) WHERE id = $1",
      [u.userId, hours],
    );
    return u;
  };
  /** Old enough to be established on age alone. */
  const established = () => aged(8 * 24);
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
  const dismiss = async (productId: string) =>
    resolveReportCase(pool, {
      ...as(admin),
      caseId: await openCase(productId),
      outcome: "DISMISSED",
      reason: REASON,
    });
  const currentVersion = async (productId: string) =>
    (
      await pool.query<{ v: string }>("SELECT current_version_id AS v FROM core.product WHERE id = $1", [
        productId,
      ])
    ).rows[0]?.v;
  /** The seller revises the live listing and the screening job approves the revision. */
  const reviseAndApprove = async (productId: string) => {
    await reviseProduct(pool, {
      ...as(c.u),
      productId,
      revision: { hook: "Mostly moon, now with more nap." },
    });
    const before = await currentVersion(productId);
    expect(await screen(pool, productId, "OK")).toMatchObject({ outcome: "REVISED" });
    expect(await currentVersion(productId)).not.toBe(before);
  };

  // ------------------------------------------------------------------ major 2
  it("major 2 (reviewer's sequence): throwaway report, dismissed, revision, four qualifying reports — the listing hides", async () => {
    const l = await publishListing(pool, c);
    await report(await aged(1), l.productId); // a throwaway account: never a qualifying report
    await dismiss(l.productId);
    await reviseAndApprove(l.productId);
    // four qualifying reporters come forward (the third report already hides it)
    for (let i = 0; i < 4; i++) {
      if ((await status(l.productId)) === "PUBLISHED") await report(await established(), l.productId);
    }
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("major 2: a dismissed case below the hide threshold of qualifying reports grants no exemption, even without a revision", async () => {
    const l = await publishListing(pool, c);
    // two qualifying reports and a throwaway one: below the threshold of three qualifying
    for (const r of [await established(), await established(), await aged(1)]) await report(r, l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    await dismiss(l.productId);
    for (let i = 0; i < 3; i++) await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("major 2: a dismissed case that had the threshold of qualifying reports exempts the reviewed version; an approved revision voids the exemption", async () => {
    const l = await publishListing(pool, c);
    for (let i = 0; i < 3; i++) await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
    expect(await dismiss(l.productId)).toMatchObject({ effect: "RESTORED", productStatus: "PUBLISHED" });
    for (let i = 0; i < 3; i++) await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED"); // exempt: the reviewed version is still live
    await reviseAndApprove(l.productId);
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("major 2: an upheld appeal exempts the reviewed version; an approved revision voids the exemption", async () => {
    const l = await publishListing(pool, c);
    for (let i = 0; i < 3; i++) await report(await established(), l.productId);
    const appeal = await createAppeal(pool, { ...as(c.u), productId: l.productId, statement: STATEMENT });
    await resolveAppeal(pool, { ...as(admin), appealId: appeal.appealId, outcome: "UPHELD", reason: REASON });
    expect(await status(l.productId)).toBe("PUBLISHED");
    for (let i = 0; i < 3; i++) await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("PUBLISHED");
    await reviseAndApprove(l.productId);
    await report(await established(), l.productId);
    expect(await status(l.productId)).toBe("HIDDEN");
  });

  it("major 2: the 90-day block on a cleared case's reporters stays as it was, whatever the case's size", async () => {
    const l = await publishListing(pool, c);
    const throwaway = await aged(1);
    await report(throwaway, l.productId);
    await dismiss(l.productId);
    await reviseAndApprove(l.productId);
    expect(await codeOf(report(throwaway, l.productId))).toBe("ALREADY_REPORTED");
  });

  // ------------------------------------------------------------------ minor 6
  /** A 48-hour-old account (too young to be established on age) with one completed purchase from `from`. */
  const buyerOf = async (from: Creator | "SEED"): Promise<TestUser> => {
    const u = await aged(48);
    if (from === "SEED") {
      const [seed] = seeds;
      if (!seed) throw new Error("no seed");
      await payFor(pool, u, await checkout(pool, u, [seed], standard("SEED")));
    } else {
      const l = asFixture(await publishListing(pool, from));
      await payFor(pool, u, await checkout(pool, u, [l], { [from.companyId]: "STANDARD" }));
    }
    return u;
  };
  const backdateOrders = (u: TestUser, days: number) =>
    plant(pool, (x) =>
      x.query(
        "UPDATE core.order_group SET created_at = now() - make_interval(days => $2) WHERE buyer_user_id = $1",
        [u.userId, days],
      ),
    );
  const backdateCompany = (s: Creator, days: number) =>
    plant(pool, (x) =>
      x.query("UPDATE core.company SET created_at = now() - make_interval(days => $2) WHERE id = $1", [
        s.companyId,
        days,
      ]),
    );
  /** Whether a report the user makes now is stored as established (the report is rolled back). */
  const establishedNow = (u: TestUser, productId: string) =>
    inRolledBackTx(pool, async (x) => {
      await become(x, { role: "app_pay", userId: u.userId });
      await x.query("SELECT core.report_create('PRODUCT', $1, 'SCAM_OR_PAYMENT', NULL, '[]'::jsonb)", [
        productId,
      ]);
      await x.query("RESET ROLE");
      const { rows } = await x.query<{ e: boolean }>(
        "SELECT reporter_established AS e FROM core.report WHERE reporter_user_id = $1",
        [u.userId],
      );
      return rows[0]?.e;
    });

  it("minor 6: a platform (DeluluMart Originals) purchase counts once it is three days old, not before", async () => {
    const l = await publishListing(pool, c);
    const u = await buyerOf("SEED");
    expect(await establishedNow(u, l.productId)).toBe(false);
    await backdateOrders(u, 2);
    expect(await establishedNow(u, l.productId)).toBe(false);
    await backdateOrders(u, 3);
    expect(await establishedNow(u, l.productId)).toBe(true);
  });

  it("minor 6: a purchase from a store younger than seven days does not count; from a week-old store it does", async () => {
    const l = await publishListing(pool, c);
    const other = await creator(pool, seeds);
    const u = await buyerOf(other);
    await backdateOrders(u, 4);
    expect(await establishedNow(u, l.productId)).toBe(false);
    await backdateCompany(other, 6);
    expect(await establishedNow(u, l.productId)).toBe(false);
    await backdateCompany(other, 7);
    expect(await establishedNow(u, l.productId)).toBe(true);
  });

  it("minor 6: a purchase from the reported product's own store never counts", async () => {
    const l = await publishListing(pool, c);
    const u = await buyerOf(c);
    await backdateOrders(u, 30);
    await backdateCompany(c, 30);
    expect(await establishedNow(u, l.productId)).toBe(false);
  });

  it("minor 6: a purchase from the reporter's own store never counts", async () => {
    const l = await publishListing(pool, c);
    const reporter = await creator(pool, seeds); // has a store of their own
    await pool.query("UPDATE core.user_profile SET created_at = now() - interval '48 hours' WHERE id = $1", [
      reporter.u.userId,
    ]);
    // a week-old completed order, as if the reporter had bought from their own week-old store (the
    // commands refuse a self-purchase, so the order is someone else's, re-attributed in this
    // rolled-back transaction only)
    const someone = await buyerOf(reporter);
    const e = await inRolledBackTx(pool, async (x) => {
      await x.query("SET LOCAL session_replication_role = replica");
      await x.query(
        "UPDATE core.order_group SET buyer_user_id = $2, created_at = now() - interval '7 days' WHERE buyer_user_id = $1",
        [someone.userId, reporter.u.userId],
      );
      await x.query("UPDATE core.seller_order SET buyer_user_id = $2 WHERE buyer_user_id = $1", [
        someone.userId,
        reporter.u.userId,
      ]);
      await x.query("UPDATE core.company SET created_at = now() - interval '30 days' WHERE id = $1", [
        reporter.companyId,
      ]);
      await x.query("SET LOCAL session_replication_role = origin");
      await become(x, { role: "app_pay", userId: reporter.u.userId });
      await x.query("SELECT core.report_create('PRODUCT', $1, 'SCAM_OR_PAYMENT', NULL, '[]'::jsonb)", [
        l.productId,
      ]);
      await x.query("RESET ROLE");
      const { rows } = await x.query<{ e: boolean }>(
        "SELECT reporter_established AS e FROM core.report WHERE reporter_user_id = $1",
        [reporter.u.userId],
      );
      return rows[0]?.e;
    });
    expect(e).toBe(false);
  });

  it("minor 6: the order age is configuration (report_established_order_min_age_days)", async () => {
    const l = await publishListing(pool, c);
    const u = await buyerOf("SEED");
    await backdateOrders(u, 2);
    const e = await inRolledBackTx(pool, async (x) => {
      await x.query(
        `UPDATE core.config_version SET values = values || '{"report_established_order_min_age_days": 1}'::jsonb
          WHERE id = core.current_config_id()`,
      );
      await become(x, { role: "app_pay", userId: u.userId });
      await x.query("SELECT core.report_create('PRODUCT', $1, 'SCAM_OR_PAYMENT', NULL, '[]'::jsonb)", [
        l.productId,
      ]);
      await x.query("RESET ROLE");
      const { rows } = await x.query<{ e: boolean }>(
        "SELECT reporter_established AS e FROM core.report WHERE reporter_user_id = $1",
        [u.userId],
      );
      return rows[0]?.e;
    });
    expect(e).toBe(true);
  });
});
