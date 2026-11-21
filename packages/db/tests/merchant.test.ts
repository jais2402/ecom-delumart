import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct, catalogProducts, storeProducts } from "../src/catalog";
import { createCheckoutSession } from "../src/checkout";
import { hideListing, restoreListing, retireUnits, setProductPrice } from "../src/listing";
import {
  createCoupon,
  earningsOf,
  myBrandProgress,
  myCoupons,
  myEarnings,
  myInventory,
  mySellerOrder,
  mySellerOrders,
  setCouponStatus,
  storeCoupons,
} from "../src/merchant";
import {
  CLEAN,
  checkout,
  codeOf,
  count,
  key,
  type ProductFixture,
  payFor,
  RUPEE,
  reconcile,
  STANDARD_DELIVERY,
  user,
} from "./checkout-fixtures";
import { createTestDatabase, plant, type TestDatabase, type TestUser } from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const REASON = "Checking the reference price rule.";

/** Merchant coupons, read models and the sale-price display rule (migrations 0041-0043). */
describe("the merchant side", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let seeds: ProductFixture[];

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    await ensureCategories(pool);
    seeds = await published(pool, 3);
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const as = (u: TestUser) => ({ authSessionId: u.authSessionId });
  const store = () => creator(pool, seeds);
  const std = (c: Creator) => ({ [c.companyId]: "STANDARD" as const });
  const ageAccount = (u: TestUser, hours: number) =>
    pool.query("UPDATE core.user_profile SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [
      u.userId,
      hours,
    ]);
  /** Every key of a JSON value, nested. */
  const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(v)) for (const x of v) keysOf(x, out);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        out.add(k);
        keysOf(x, out);
      }
    }
    return out;
  };
  const asOwner = async <T>(u: TestUser, sql: string, params: unknown[] = []): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.session_id', $1, true)", [u.authSessionId]);
      await client.query("SET LOCAL ROLE app_web");
      const { rows } = await client.query<{ r: T }>(sql, params);
      return rows[0]?.r as T;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  // ------------------------------------------------------------------ coupons
  describe("coupons", () => {
    it("US-41: five active coupons per company (COUPON_LIMIT), counted again on resume", async () => {
      const c = await store();
      const made = [];
      for (let i = 0; i < 5; i++) {
        made.push(
          await createCoupon(pool, { ...as(c.u), coupon: { kind: "PERCENT", value: 10n, isPublic: false } }),
        );
      }
      expect(
        await codeOf(
          createCoupon(pool, {
            ...as(c.u),
            coupon: { kind: "FLAT", value: 500n * RUPEE, isPublic: true, publicCode: "SIXTH" },
          }),
        ),
      ).toBe("COUPON_LIMIT");
      await setCouponStatus(pool, { ...as(c.u), couponId: made[0]?.couponId ?? "", status: "PAUSED" });
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "FLAT", value: 500n * RUPEE, isPublic: true, publicCode: "SIXTH" },
      });
      expect(
        await codeOf(
          setCouponStatus(pool, { ...as(c.u), couponId: made[0]?.couponId ?? "", status: "ACTIVE" }),
        ),
      ).toBe("COUPON_LIMIT");
      const mine = await myCoupons(pool, as(c.u));
      expect(mine).toMatchObject({ activeCount: 5, activeMax: 5 });
      expect(mine.items).toHaveLength(6);
    });

    it("US-41: my_coupons shows every code to the owner only; store_coupons lists only public coupons usable now", async () => {
      const c = await store();
      const priv = await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 15n, isPublic: false },
      });
      const pub = await createCoupon(pool, {
        ...as(c.u),
        coupon: {
          kind: "FLAT",
          value: 200n * RUPEE,
          minSpendPaise: 1_000n * RUPEE,
          isPublic: true,
          publicCode: "moon200",
        },
      });
      const paused = await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 5n, isPublic: true, publicCode: "PAUSED5" },
      });
      await setCouponStatus(pool, { ...as(c.u), couponId: paused.couponId, status: "PAUSED" });
      await createCoupon(pool, {
        ...as(c.u),
        coupon: {
          kind: "PERCENT",
          value: 5n,
          isPublic: true,
          publicCode: "LATER5",
          startsAt: new Date(Date.now() + 86_400_000),
        },
      });
      const mine = await myCoupons(pool, as(c.u));
      const byId = new Map(mine.items.map((i) => [i.couponId, i]));
      expect(byId.get(priv.couponId)).toMatchObject({
        code: priv.code,
        isPublic: false,
        kind: "PERCENT",
        percent: 15,
        status: "ACTIVE",
      });
      expect(byId.get(pub.couponId)).toMatchObject({
        code: "MOON200",
        isPublic: true,
        amountPaise: 200n * RUPEE,
        minSpendPaise: 1_000n * RUPEE,
        redeemed: 0,
        discountGivenPaise: 0n,
      });
      const listed = await storeCoupons(pool, c.handle);
      expect(listed.map((x) => x.code)).toEqual(["MOON200"]);
      expect(JSON.stringify(listed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
        priv.code,
      );
      // another account sees none of this store's coupons; without a company it has none of its own
      const stranger = await user(pool);
      expect(await codeOf(myCoupons(pool, as(stranger)))).toBe("COMPANY_FEE_REQUIRED");
      const other = await store();
      expect((await myCoupons(pool, as(other.u))).items).toEqual([]);
      expect(
        await codeOf(setCouponStatus(pool, { ...as(other.u), couponId: priv.couponId, status: "ENDED" })),
      ).toBe("FORBIDDEN");
    });

    it("US-41: a buyer redeems once; the owner cannot redeem; redemptions and the discount given are counted", async () => {
      const c = await store();
      const p = asFixture(await publishListing(pool, c, { quantity: 3, pricePaise: 10_000n * RUPEE }));
      const pub = await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 10n, isPublic: true, publicCode: "TENOFF" },
      });
      const buyer = await user(pool);
      const co = await checkout(pool, buyer, [p], std(c), "tenoff");
      expect(co.totalPaise).toBe(9_000n * RUPEE + STANDARD_DELIVERY);
      await payFor(pool, buyer, co);
      const owner = createCheckoutSession(pool, {
        authSessionId: c.u.authSessionId,
        lines: [{ productId: p.id }],
        speedBySeller: std(c),
        couponCode: "TENOFF",
        idempotencyKey: key(),
      });
      expect(["SELF_PURCHASE", "COUPON_NOT_APPLICABLE"]).toContain(await codeOf(owner));
      const mine = (await myCoupons(pool, as(c.u))).items.find((i) => i.couponId === pub.couponId);
      expect(mine).toMatchObject({ redeemed: 1, discountGivenPaise: 1_000n * RUPEE });
    });
  });

  // ------------------------------------------------------------------ orders
  describe("seller orders", () => {
    it("US-45: the owner reads their seller orders with the finances, never a buyer's identity; other stores cannot", async () => {
      const a = await store();
      const b = await store();
      const p = asFixture(
        await publishListing(pool, a, {
          quantity: 2,
          pricePaise: 2_000n * RUPEE,
          freeStandardDelivery: true,
        }),
      );
      await createCoupon(pool, {
        ...as(a.u),
        coupon: { kind: "PERCENT", value: 10n, isPublic: true, publicCode: "AOWN10" },
      });
      const buyer = await user(pool);
      await payFor(pool, buyer, await checkout(pool, buyer, [p], std(a), "AOWN10"));

      const page = await mySellerOrders(pool, as(a.u));
      expect(page.items).toHaveLength(1);
      const o = page.items[0];
      expect(o).toMatchObject({
        buyer: "Anonymous player",
        source: "PLAYER",
        status: "COMPLETED",
        listPaise: 2_000n * RUPEE,
        discountPaise: 200n * RUPEE,
        grossPaise: 1_800n * RUPEE,
        feePaise: 90n * RUPEE,
        deliveryFeeBuyerPaise: 0n,
        deliveryFeeSellerPaise: STANDARD_DELIVERY,
        netPaise: 1_800n * RUPEE - 90n * RUPEE - STANDARD_DELIVERY,
        couponCode: "AOWN10",
      });
      expect(o?.delivery?.speed).toBe("STANDARD");
      expect(o?.lines).toEqual([
        expect.objectContaining({
          productId: p.id,
          listPaise: 2_000n * RUPEE,
          discountPaise: 200n * RUPEE,
          feePaise: 90n * RUPEE,
        }),
      ]);
      expect(
        (await mySellerOrder(pool, { ...as(a.u), sellerOrderId: o?.sellerOrderId ?? "" })).netPaise,
      ).toBe(o?.netPaise);

      // no buyer identity anywhere: assert on the returned keys and on the raw text
      const raw = await asOwner<unknown>(a.u, "SELECT core.my_seller_orders(NULL, NULL) AS r");
      const keys = keysOf(raw);
      for (const forbidden of [
        "buyerUserId",
        "buyer_user_id",
        "userId",
        "email",
        "phone",
        "address",
        "addressId",
        "name_",
        "buyerId",
      ]) {
        expect(keys.has(forbidden), forbidden).toBe(false);
      }
      expect([...keys].sort()).toEqual(
        [
          "buyer",
          "couponCode",
          "cancelledAt",
          "deliveredAt",
          "delivery",
          "deliveryFeeBuyerPaise",
          "deliveryFeeSellerPaise",
          "discountPaise",
          "editionSerial",
          "feePaise",
          "grossPaise",
          "items",
          "lines",
          "listPaise",
          "name",
          "netPaise",
          "nextCursor",
          "orderedAt",
          "outAt",
          "packedAt",
          "placedAt",
          "productId",
          "sellerOrderId",
          "shippedAt",
          "source",
          "speed",
          "status",
        ].sort(),
      );
      expect(JSON.stringify(raw)).not.toContain(buyer.userId);

      // user B: no orders of A, NOT_FOUND for A's order (as for a missing one), A's totals stay A's
      expect((await mySellerOrders(pool, as(b.u))).items).toEqual([]);
      expect(await codeOf(mySellerOrder(pool, { ...as(b.u), sellerOrderId: o?.sellerOrderId ?? "" }))).toBe(
        "NOT_FOUND",
      );
      expect((await myEarnings(pool, as(b.u))).current.orders).toBe(0);
      expect((await myInventory(pool, as(b.u))).products).toEqual([]);
      expect((await myBrandProgress(pool, as(b.u))).qualifyingGrossPaise).toBe(0n);
      // and a player without a company has no merchant reads at all
      for (const call of [
        () => mySellerOrders(pool, as(buyer)),
        () => myEarnings(pool, as(buyer)),
        () => myBrandProgress(pool, as(buyer)),
        () => myInventory(pool, as(buyer)),
      ]) {
        expect(await codeOf(call())).toBe("COMPANY_FEE_REQUIRED");
      }
    });
  });

  // ------------------------------------------------------------------ earnings
  describe("earnings", () => {
    it("US-45: across 30 generated orders with coupons and merchant-funded delivery, net equals the ledger credits", async () => {
      const c = await store();
      const products = [
        asFixture(
          await publishListing(pool, c, {
            quantity: 10,
            pricePaise: 5_000n * RUPEE,
            freeStandardDelivery: true,
          }),
        ),
        asFixture(await publishListing(pool, c, { quantity: 10, pricePaise: 1_234n * RUPEE })),
        asFixture(
          await publishListing(pool, c, {
            quantity: 10,
            pricePaise: 7_777n * RUPEE,
            freeStandardDelivery: true,
          }),
        ),
      ];
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 12n, isPublic: true, publicCode: "PCT12" },
      });
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "FLAT", value: 150n * RUPEE, isPublic: true, publicCode: "FLAT150" },
      });
      const ownerWalletBefore = (
        await pool.query<{ p: string }>(
          "SELECT available_paise::text AS p FROM ledger.wallet WHERE account_id = $1",
          [c.u.ledgerAccountId],
        )
      ).rows[0]?.p;
      for (let i = 0; i < 10; i++) {
        const buyer = await user(pool);
        for (let j = 0; j < 3; j++) {
          const coupon = [undefined, "PCT12", "FLAT150"][(i + j) % 3];
          await payFor(
            pool,
            buyer,
            await checkout(pool, buyer, [products[j] as ProductFixture], std(c), coupon),
          );
        }
      }
      const e = await myEarnings(pool, { ...as(c.u), days: 30 });
      expect(e.current.orders).toBe(30);
      expect(e.current.distinctBuyers).toBe(10);
      const ledger = await pool.query<{ credited: string; gross: string; fees: string; delivery: string }>(
        `SELECT (SELECT COALESCE(SUM(p.amount), 0) FROM ledger.posting p
                  WHERE p.account_id = $2 AND p.amount > 0
                    AND p.seller_order_id IN (SELECT so.id FROM core.seller_order so WHERE so.company_id = $1))::text AS credited,
                SUM(so.list_paise - so.seller_discount_paise)::text AS gross, SUM(so.fee_paise)::text AS fees,
                SUM(so.delivery_fee_seller_paise)::text AS delivery
           FROM core.seller_order so WHERE so.company_id = $1`,
        [c.companyId, c.u.ledgerAccountId],
      );
      const l = ledger.rows[0];
      expect(e.current.netPaise).toBe(BigInt(l?.credited ?? "-1"));
      expect(e.current.grossPaise).toBe(BigInt(l?.gross ?? "-1"));
      expect(e.current.feesPaise).toBe(BigInt(l?.fees ?? "-1"));
      expect(e.current.merchantDeliveryPaise).toBe(20n * STANDARD_DELIVERY);
      expect(e.current.netPaise).toBe(
        e.current.grossPaise - e.current.feesPaise - e.current.merchantDeliveryPaise,
      );
      expect(e.current.averageOrderPaise).toBe(e.current.grossPaise / 30n);
      // the owner's wallet grew by exactly the net
      const after = (
        await pool.query<{ p: string }>(
          "SELECT available_paise::text AS p FROM ledger.wallet WHERE account_id = $1",
          [c.u.ledgerAccountId],
        )
      ).rows[0]?.p;
      expect(BigInt(after ?? "0") - BigInt(ownerWalletBefore ?? "0")).toBe(e.current.netPaise);
      // the daily series adds up to the period; top products by gross
      expect(e.daily).toHaveLength(30);
      expect(e.daily.reduce((s, d) => s + d.netPaise, 0n)).toBe(e.current.netPaise);
      expect(e.daily.reduce((s, d) => s + d.orders, 0)).toBe(30);
      expect(e.topProducts.map((t) => t.productId).sort()).toEqual(products.map((p) => p.id).sort());
      const grosses = e.topProducts.map((t) => t.grossPaise);
      expect([...grosses].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))).toEqual(grosses);
      expect(grosses.reduce((s, g) => s + g, 0n)).toBe(e.current.grossPaise);
      expect(e.topProducts.every((t) => t.units === 10)).toBe(true);
      expect(e.previous.orders).toBe(0);
      // the period is capped at 90 days
      expect((await myEarnings(pool, { ...as(c.u), days: 400 })).periodDays).toBe(90);
      expect(await codeOf(myEarnings(pool, { ...as(c.u), days: 0 }))).toBe("VALIDATION_FAILED");
    });

    it("US-45: periods and the daily series bucket by the company's time zone (Asia/Kolkata); STAFF orders apart", async () => {
      const c = await store();
      const p1 = asFixture(await publishListing(pool, c, { quantity: 2, pricePaise: 1_000n * RUPEE }));
      const p2 = asFixture(await publishListing(pool, c, { quantity: 2, pricePaise: 3_000n * RUPEE }));
      const late = await user(pool); // 23:30 IST on 10 March (18:00 UTC)
      const early = await user(pool); // 00:30 IST on 11 March (19:00 UTC): the same UTC day
      const staff = await user(pool);
      await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [staff.userId]);
      const r1 = await payFor(pool, late, await checkout(pool, late, [p1], std(c)));
      const r2 = await payFor(pool, early, await checkout(pool, early, [p2], std(c)));
      const r3 = await payFor(pool, staff, await checkout(pool, staff, [p1], std(c)));
      // planted: an order group's time never changes through the application
      await plant(pool, async (x) => {
        await x.query("UPDATE core.order_group SET created_at = '2026-03-10T18:00:00Z' WHERE id = $1", [
          r1.orderGroupId,
        ]);
        await x.query("UPDATE core.order_group SET created_at = '2026-03-10T19:00:00Z' WHERE id = $1", [
          r2.orderGroupId,
        ]);
        await x.query("UPDATE core.order_group SET created_at = '2026-03-11T05:00:00Z' WHERE id = $1", [
          r3.orderGroupId,
        ]);
      });
      const at = async (days: number, asOf: string) =>
        earningsOf(
          (
            await pool.query<{ r: Record<string, unknown> }>(
              "SELECT core.company_earnings($1, $2, $3) AS r",
              [c.companyId, days, asOf],
            )
          ).rows[0]?.r ?? {},
        );
      const one = await at(1, "2026-03-11T12:00:00Z");
      expect(one.timeZone).toBe("Asia/Kolkata");
      expect(one.current).toMatchObject({ orders: 1, grossPaise: 3_000n * RUPEE });
      expect(one.previous).toMatchObject({ orders: 1, grossPaise: 1_000n * RUPEE });
      expect(one.current.from.toISOString()).toBe("2026-03-10T18:30:00.000Z");
      expect(one.daily).toEqual([
        { date: "2026-03-11", orders: 1, grossPaise: 3_000n * RUPEE, netPaise: one.current.netPaise },
      ]);
      expect(one.staff.current).toMatchObject({ orders: 1, grossPaise: 1_000n * RUPEE });
      const two = await at(2, "2026-03-11T12:00:00Z");
      expect(two.current.orders).toBe(2);
      expect(two.daily.map((d) => [d.date, d.orders])).toEqual([
        ["2026-03-10", 1],
        ["2026-03-11", 1],
      ]);
      // as of the next local day, both March orders are in the previous period
      const next = await at(1, "2026-03-11T18:31:00Z");
      expect(next.current.orders).toBe(0);
      expect(next.previous.orders).toBe(1);
    });
  });

  // ------------------------------------------------------------------ brand progress
  describe("brand progress", () => {
    it("US-20: counts buyer-paid amounts of PLAYER orders; eligible buyers only once their accounts are 24 hours old; never STAFF", async () => {
      const c = await store();
      const p = asFixture(await publishListing(pool, c, { quantity: 5, pricePaise: 4_000n * RUPEE }));
      await createCoupon(pool, {
        ...as(c.u),
        coupon: { kind: "PERCENT", value: 25n, isPublic: true, publicCode: "QUARTER" },
      });
      const young = await user(pool);
      const old = await user(pool);
      const staff = await user(pool);
      await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [staff.userId]);
      await ageAccount(staff, 72);
      await payFor(pool, young, await checkout(pool, young, [p], std(c), "QUARTER"));
      await payFor(pool, old, await checkout(pool, old, [p], std(c)));
      await payFor(pool, staff, await checkout(pool, staff, [p], std(c)));
      let progress = await myBrandProgress(pool, as(c.u));
      expect(progress).toMatchObject({
        qualifyingGrossPaise: 3_000n * RUPEE + 4_000n * RUPEE,
        eligibleBuyers: 0,
        thresholdPaise: 10n * 10_000_000n * RUPEE,
        minBuyers: 5,
        qualifies: false,
        tier: "SOLO",
        brandUnlocked: false,
      });
      await ageAccount(old, 24);
      await ageAccount(young, 23);
      progress = await myBrandProgress(pool, as(c.u));
      expect(progress.eligibleBuyers).toBe(1);
      await ageAccount(young, 25);
      expect((await myBrandProgress(pool, as(c.u))).eligibleBuyers).toBe(2);
      // nothing is granted by reading
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.company WHERE id = $1 AND tier = 'BRAND'", [
          c.companyId,
        ]),
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------------ inventory
  describe("inventory", () => {
    it("warehouses with free space and the Zap hub; per product available, issued, retired, low stock and editions", async () => {
      const c = await store();
      const plenty = await publishListing(pool, c, { quantity: 8 });
      const edition = await publishListing(pool, c, { quantity: 4, inventoryMode: "EXCLUSIVE" });
      const buyer = await user(pool);
      await payFor(pool, buyer, await checkout(pool, buyer, [asFixture(plenty), asFixture(edition)], std(c)));
      await retireUnits(pool, { ...as(c.u), productId: plenty.productId, quantity: 1 });
      const inv = await myInventory(pool, as(c.u));
      expect(inv.warehouses).toEqual([
        { id: c.warehouseId, kind: "STARTER", capacity: 100, used: 9, free: 91, zapHub: false },
      ]);
      const byId = new Map(inv.products.map((p) => [p.productId, p]));
      expect(byId.get(plenty.productId)).toMatchObject({
        available: 6,
        issued: 1,
        retired: 1,
        lowStock: false,
        edition: null,
      });
      expect(byId.get(edition.productId)).toMatchObject({
        available: 3,
        issued: 1,
        lowStock: true,
        edition: { supply: 4, issued: 1 },
      });
      expect(inv.lowStockThreshold).toBe(5);
    });
  });

  // ------------------------------------------------------------------ reference price
  describe("the sale-price display rule", () => {
    /** Moves the listing's price history back so the earlier price was live for `hours` (+ `extra`) before the change. */
    const backdate = (productId: string, interval: string) =>
      plant(pool, (x) =>
        x.query(
          `UPDATE core.price_history SET changed_at = (SELECT max(changed_at) FROM core.price_history WHERE product_id = $1) - $2::interval
            WHERE product_id = $1 AND id < (SELECT max(id) FROM core.price_history WHERE product_id = $1)`,
          [productId, interval],
        ),
      );
    const ref = async (productId: string) => (await catalogProduct(pool, productId))?.referencePricePaise;

    it("US-43: a cut after exactly 24 hours at the earlier price shows it everywhere the product is listed", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      expect(await ref(l.productId)).toBeNull();
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 800n * RUPEE });
      expect(await ref(l.productId)).toBeNull(); // live for seconds only
      await backdate(l.productId, "24 hours");
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
      const inStore = (await storeProducts(pool, { handle: c.handle })).items.find(
        (p) => p.productId === l.productId,
      );
      expect(inStore?.referencePricePaise).toBe(1_000n * RUPEE);
      let found: bigint | null | undefined;
      let cursor: string | null = null;
      do {
        const page = await catalogProducts(pool, { cursor, pageSize: 50 });
        found ??= page.items.find((p) => p.productId === l.productId)?.referencePricePaise;
        cursor = page.nextCursor;
      } while (cursor !== null && found === undefined);
      expect(found).toBe(1_000n * RUPEE);
    });

    it("US-43: one microsecond short of 24 hours shows nothing", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 800n * RUPEE });
      await backdate(l.productId, "23 hours 59 minutes 59.999999 seconds");
      expect(await ref(l.productId)).toBeNull();
    });

    it("US-43: a price increase shows no reference, however long the earlier price was live", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 1_500n * RUPEE });
      await backdate(l.productId, "30 days");
      expect(await ref(l.productId)).toBeNull();
    });

    it("US-43: a listing hidden while the earlier price was live was not continuously published", async () => {
      const c = await store();
      const l = await publishListing(pool, c, { pricePaise: 1_000n * RUPEE });
      await hideListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await restoreListing(pool, { ...as(admin), productId: l.productId, reason: REASON });
      await setProductPrice(pool, { ...as(c.u), productId: l.productId, pricePaise: 800n * RUPEE });
      await backdate(l.productId, "48 hours");
      expect(await ref(l.productId)).toBeNull();
      // the same history without the hide would show it
      await plant(pool, (x) => x.query("DELETE FROM core.listing_hide WHERE product_id = $1", [l.productId]));
      expect(await ref(l.productId)).toBe(1_000n * RUPEE);
    });
  });
});
