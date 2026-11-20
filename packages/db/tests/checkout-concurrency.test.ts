import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PayReceipt } from "../src/checkout";
import {
  CLEAN,
  CRORE,
  checkout,
  codeOf,
  count,
  key,
  merchantCoupon,
  payFor,
  product,
  RUPEE,
  reconcile,
  STANDARD_DELIVERY,
  seller,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, type TestDatabase } from "./helpers";

const STARTER = 100n * CRORE;

/** Outcome codes of concurrently settled pay calls; "ok" for a receipt. */
async function settle(calls: Promise<PayReceipt>[]): Promise<{ codes: string[]; receipts: PayReceipt[] }> {
  const results = await Promise.allSettled(calls);
  const receipts = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const codes = await Promise.all(
    results.map((r) => codeOf(r.status === "fulfilled" ? Promise.resolve() : Promise.reject(r.reason))),
  );
  return { codes, receipts };
}

describe("checkout concurrency (separate connections)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  it("US-30: two buyers for the last unit of an EXCLUSIVE product — one order, one SOLD_OUT, loser not debited, serial issued once", async () => {
    const s = await seller(pool);
    const p = await product(pool, { seller: s, mode: "EXCLUSIVE", pricePaise: 5_000n * RUPEE, units: 1 });
    const a = await user(pool);
    const b = await user(pool);
    const coA = await checkout(pool, a, [p], standard(s));
    const coB = await checkout(pool, b, [p], standard(s));

    const { codes, receipts } = await settle([payFor(pool, a, coA), payFor(pool, b, coB)]);

    expect(codes.sort()).toEqual(["SOLD_OUT", "ok"]);
    expect(receipts).toHaveLength(1);
    const [winnerUser, loserUser] = (await ownerOf(p.id)) === a.userId ? [a, b] : [b, a];
    expect(await wallet(pool, winnerUser.ledgerAccountId)).toBe(STARTER - 5_000n * RUPEE - STANDARD_DELIVERY);
    expect(await wallet(pool, loserUser.ledgerAccountId)).toBe(STARTER);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM core.inventory_unit WHERE product_id = $1 AND state = 'ISSUED'",
        [p.id],
      ),
    ).toBe(1);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM core.order_line WHERE product_id = $1 AND edition_serial = 1",
        [p.id],
      ),
    ).toBe(1);
    expect(await count(pool, "SELECT count(*) AS n FROM core.ownership WHERE product_id = $1", [p.id])).toBe(
      1,
    );
  });

  async function ownerOf(productId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM core.ownership WHERE product_id = $1",
      [productId],
    );
    return rows[0]?.user_id;
  }

  it("one buyer, two sessions whose totals each fit but together exceed the balance — exactly one succeeds, no negative wallet", async () => {
    const buyer = await user(pool);
    const p1 = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 60n * CRORE });
    const p2 = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 60n * CRORE });
    const co1 = await checkout(pool, buyer, [p1], standard("SEED"));
    const co2 = await checkout(pool, buyer, [p2], standard("SEED"));

    const { codes } = await settle([payFor(pool, buyer, co1), payFor(pool, buyer, co2)]);

    expect(codes.sort()).toEqual(["INSUFFICIENT_FUNDS", "ok"]);
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(STARTER - 60n * CRORE - STANDARD_DELIVERY);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [
        buyer.userId,
      ]),
    ).toBe(1);
  });

  it("the same pay request fired 10 times concurrently with the same key makes one order and returns one receipt", async () => {
    const buyer = await user(pool);
    const s = await seller(pool);
    const p = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 2_000n * RUPEE,
      units: 3,
    });
    const co = await checkout(pool, buyer, [p], standard(s));
    const k = key();

    const { codes, receipts } = await settle(Array.from({ length: 10 }, () => payFor(pool, buyer, co, k)));

    expect(codes).toEqual(Array(10).fill("ok"));
    expect(new Set(receipts.map((r) => r.orderGroupId)).size).toBe(1);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.order_group WHERE session_id = $1", [co.sessionId]),
    ).toBe(1);
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(STARTER - 2_000n * RUPEE - STANDARD_DELIVERY);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM core.inventory_unit WHERE product_id = $1 AND state = 'ISSUED'",
        [p.id],
      ),
    ).toBe(1);
  });

  it("US-41: a coupon with max_redemptions 1 used by two buyers concurrently is redeemed once", async () => {
    const s = await seller(pool);
    const couponId = await merchantCoupon(pool, s, { code: "JUSTONE", percent: 10, maxRedemptions: 1 });
    const p1 = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 1_000n * RUPEE,
      units: 1,
    });
    const p2 = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 1_000n * RUPEE,
      units: 1,
    });
    const a = await user(pool);
    const b = await user(pool);
    const coA = await checkout(pool, a, [p1], standard(s), "JUSTONE");
    const coB = await checkout(pool, b, [p2], standard(s), "JUSTONE");

    const { codes } = await settle([payFor(pool, a, coA), payFor(pool, b, coB)]);

    expect(codes.sort()).toEqual(["COUPON_INVALID", "ok"]);
    const coupon = await pool.query<{ redeemed: number }>("SELECT redeemed FROM core.coupon WHERE id = $1", [
      couponId,
    ]);
    expect(coupon.rows[0]?.redeemed).toBe(1);
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.coupon_redemption WHERE coupon_id = $1", [couponId]),
    ).toBe(1);
  });

  it("buyers and sellers paying each other at once never deadlock (wallets lock in ascending account order)", async () => {
    const s1 = await seller(pool);
    const s2 = await seller(pool);
    const p1 = await product(pool, {
      seller: s1,
      mode: "STANDARD_STOCKED",
      pricePaise: 1_000n * RUPEE,
      units: 5,
    });
    const p2 = await product(pool, {
      seller: s2,
      mode: "STANDARD_STOCKED",
      pricePaise: 1_000n * RUPEE,
      units: 5,
    });
    const shared = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
    // s1's owner buys from s2 while s2's owner buys from s1, plus third parties buying from both
    const c = await user(pool);
    const d = await user(pool);
    const plans = [
      [s1.owner, await checkout(pool, s1.owner, [p2, shared], standard(s2, "SEED"))],
      [s2.owner, await checkout(pool, s2.owner, [p1, shared], standard(s1, "SEED"))],
      [c, await checkout(pool, c, [p1, p2], standard(s1, s2))],
      [d, await checkout(pool, d, [p2, p1], standard(s2, s1))],
    ] as const;

    const { codes } = await settle(plans.map(([buyer, co]) => payFor(pool, buyer, co)));

    expect(codes).toEqual(["ok", "ok", "ok", "ok"]);
  });
});
