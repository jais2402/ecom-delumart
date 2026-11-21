import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cartAdd,
  cartClear,
  cartMerge,
  cartRemove,
  cartWithPreview,
  createCheckoutSessionFromCart,
  myCart,
  previewCart,
} from "../src/cart";
import { createPaymentAttempt, pay } from "../src/checkout";
import {
  CLEAN,
  checkout,
  codeOf,
  key,
  merchantCoupon,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  reconcile,
  type Seller,
  STANDARD_DELIVERY,
  seller,
  standard,
  user,
} from "./checkout-fixtures";
import {
  countRows,
  createProfile,
  createTestDatabase,
  plant,
  sessionFor,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

/** PRD R2.2 cart rules and US-33 (migration 0028, packages/db/src/cart.ts). */
describe("cart", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: TestUser;
  let b: TestUser;
  let s: Seller;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 40 });
    pool = db.pool;
    a = await user(pool);
    b = await user(pool);
    s = await seller(pool);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const seed = (rupees = 500n): Promise<ProductFixture> =>
    product(pool, { mode: "UNLIMITED_SEED", pricePaise: rupees * RUPEE });
  const stocked = (opts: { units?: number; rupees?: bigint; freeStd?: boolean; express?: boolean } = {}) =>
    product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: (opts.rupees ?? 700n) * RUPEE,
      units: opts.units ?? 3,
      freeStd: opts.freeStd ?? false,
      express: opts.express ?? false,
    });
  const add = (u: TestUser, p: { id: string }) =>
    cartAdd(pool, { authSessionId: u.authSessionId, productId: p.id });
  const ids = async (u: TestUser) =>
    (await myCart(pool, { authSessionId: u.authSessionId })).lines.map((l) => l.productId);
  const clear = (u: TestUser) => cartClear(pool, { authSessionId: u.authSessionId });

  describe("adding", () => {
    it("R2.2: a published seed product is added with its catalog fields, seller and availability", async () => {
      await clear(a);
      const p = await seed(450n);
      const cart = await add(a, p);
      expect(cart.lines).toHaveLength(1);
      expect(cart.lines[0]).toMatchObject({
        productId: p.id,
        versionId: p.versionId,
        name: "Moon Lamp",
        altText: "A round lamp",
        templateId: 1,
        pricePaise: 450n * RUPEE,
        category: "gadgets",
        sellerKey: "SEED",
        sellerName: "DeluluMart Originals",
        available: true,
        offersExpress: false,
        zapAvailable: false,
        freeStandardDelivery: false,
        issue: null,
      });
      expect(cart.lines[0]?.addedAt).toBeInstanceOf(Date);
    });

    it("R2.2: a user company's product carries the company as seller and its delivery flags", async () => {
      await clear(a);
      const p = await stocked({ freeStd: true, express: true });
      const [line] = (await add(a, p)).lines;
      const { rows } = await pool.query<{ name: string }>("SELECT name FROM core.company WHERE id = $1", [
        s.companyId,
      ]);
      expect(line).toMatchObject({
        sellerKey: s.companyId,
        sellerName: rows[0]?.name,
        offersExpress: true,
        freeStandardDelivery: true,
        zapAvailable: false,
        available: true,
        issue: null,
      });
    });

    it("R2.2: zap is available for a user seller only while a unit sits in its zap hub", async () => {
      await clear(a);
      const hub = uuidv7();
      await pool.query(
        "INSERT INTO core.warehouse (id, company_id, kind, capacity, used, zap_hub) VALUES ($1, $2, 'PURCHASED', 10, 0, true)",
        [hub, s.companyId],
      );
      const inHub = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 800n * RUPEE,
        units: 1,
        warehouseId: hub,
      });
      const elsewhere = await stocked();
      const seedZap = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 300n * RUPEE, zap: true });
      await add(a, inHub);
      await add(a, elsewhere);
      const cart = await add(a, seedZap);
      const zap = Object.fromEntries(cart.lines.map((l) => [l.productId, l.zapAvailable]));
      expect(zap).toEqual({ [inHub.id]: true, [elsewhere.id]: false, [seedZap.id]: true });
    });

    it("R2.2: adding a product already in the cart is a no-op success", async () => {
      await clear(a);
      const p = await seed();
      const first = await add(a, p);
      const again = await add(a, p);
      expect(again.lines).toEqual(first.lines);
    });

    it("R2.2: a product that is not published (or does not exist) cannot be added", async () => {
      await clear(a);
      const p = await seed();
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [p.id]);
      expect(await codeOf(add(a, p))).toBe("PRODUCT_UNAVAILABLE");
      expect(await codeOf(add(a, { id: uuidv7() }))).toBe("PRODUCT_UNAVAILABLE");
      expect(await ids(a)).toEqual([]);
    });

    it("R2.2 US-09: a product the person already owns cannot be added (ALREADY_OWNED)", async () => {
      const buyer = await user(pool);
      const p = await seed();
      await payFor(pool, buyer, await checkout(pool, buyer, [p], standard("SEED")));
      expect(await codeOf(add(buyer, p))).toBe("ALREADY_OWNED");
      expect(await ids(buyer)).toEqual([]);
    });

    it("R2.2: a person may not add their own company's products (SELF_PURCHASE)", async () => {
      const p = await stocked();
      expect(await codeOf(add(s.owner, p))).toBe("SELF_PURCHASE");
      expect(await ids(s.owner)).toEqual([]);
    });

    it("R2.2: at most 20 lines; the 21st is CART_FULL, re-adding an existing line still succeeds", async () => {
      await clear(a);
      const products = await Promise.all(Array.from({ length: 21 }, () => seed()));
      for (const p of products.slice(0, 20)) await add(a, p);
      expect(await codeOf(add(a, products[20] as ProductFixture))).toBe("CART_FULL");
      expect((await add(a, products[0] as ProductFixture)).lines).toHaveLength(20);
      expect(await ids(a)).toEqual(products.slice(0, 20).map((p) => p.id));
    });

    it("R2.2: 30 concurrent adds never make more than 20 lines", async () => {
      const buyer = await user(pool);
      const products = await Promise.all(Array.from({ length: 30 }, () => seed()));
      const codes = await Promise.all(products.map((p) => codeOf(add(buyer, p))));
      expect(codes.filter((c) => c === "ok")).toHaveLength(20);
      expect(codes.filter((c) => c === "CART_FULL")).toHaveLength(10);
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.cart_line WHERE user_id = $1", [buyer.userId]),
      ).toBe(20);
    });

    it("a signed-in user without a profile (before the phone step) cannot add: PHONE_REQUIRED", async () => {
      const id = uuidv7();
      const session = await sessionFor(pool, id);
      const p = await seed();
      expect(await codeOf(cartAdd(pool, { authSessionId: session, productId: p.id }))).toBe("PHONE_REQUIRED");
      expect((await myCart(pool, { authSessionId: session })).lines).toEqual([]);
    });

    it("rejects a malformed product id before reaching the database", async () => {
      expect(await codeOf(cartAdd(pool, { authSessionId: a.authSessionId, productId: "nope" }))).toBe(
        "VALIDATION_FAILED",
      );
    });
  });

  describe("removing and clearing", () => {
    it("R2.2: remove drops one line (absent is a no-op); clear empties the cart", async () => {
      await clear(a);
      const [p1, p2, p3] = await Promise.all([seed(), seed(), seed()]);
      for (const p of [p1, p2, p3]) await add(a, p as ProductFixture);
      const after = await cartRemove(pool, {
        authSessionId: a.authSessionId,
        productId: (p2 as ProductFixture).id,
      });
      expect(after.lines.map((l) => l.productId)).toEqual([p1?.id, p3?.id]);
      const again = await cartRemove(pool, {
        authSessionId: a.authSessionId,
        productId: (p2 as ProductFixture).id,
      });
      expect(again.lines.map((l) => l.productId)).toEqual([p1?.id, p3?.id]);
      expect((await clear(a)).lines).toEqual([]);
    });
  });

  describe("isolation", () => {
    it("user A can never see or change user B's cart", async () => {
      await clear(a);
      await clear(b);
      const [pa, pb] = await Promise.all([seed(), seed()]);
      await add(a, pa as ProductFixture);
      await add(b, pb as ProductFixture);
      expect(await ids(a)).toEqual([pa?.id]);
      expect(await ids(b)).toEqual([pb?.id]);
      // B removing A's product, and B clearing, touch only B's own cart
      await cartRemove(pool, { authSessionId: b.authSessionId, productId: (pa as ProductFixture).id });
      await clear(b);
      expect(await ids(a)).toEqual([pa?.id]);
      expect(await ids(b)).toEqual([]);
    });

    it("application roles have no direct access to core.cart_line; RLS is on", async () => {
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker"]) {
        for (const sql of [
          "SELECT 1 FROM core.cart_line",
          "INSERT INTO core.cart_line (user_id, product_id) VALUES (gen_random_uuid(), gen_random_uuid())",
          "UPDATE core.cart_line SET added_at = now()",
          "DELETE FROM core.cart_line",
        ]) {
          expect(await stateOf(pool, sql, [], { role, userId: a.userId }), `${role}: ${sql}`).toBe("42501");
        }
      }
      const { rows } = await pool.query<{ rls: boolean }>(
        "SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'core.cart_line'::regclass",
      );
      expect(rows[0]?.rls).toBe(true);
    });

    it("every cart function needs a signed-in session (FORBIDDEN without one)", async () => {
      for (const sql of [
        "SELECT core.my_cart()",
        "SELECT core.cart_add(gen_random_uuid())",
        "SELECT core.cart_remove(gen_random_uuid())",
        "SELECT core.cart_clear()",
        "SELECT core.cart_merge(ARRAY[]::uuid[])",
        "SELECT core.cart_quote_inputs('{}'::jsonb)",
      ]) {
        expect(await stateOf(pool, sql, [], { role: "app_pay" }), sql).toBe("DM001");
      }
    });

    it("the cart functions are executable by app_web and app_pay only (the quote inputs by app_pay only)", async () => {
      const { rows } = await pool.query<{ r: string; f: string }>(
        `SELECT r, f FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r,
                unnest(ARRAY['core.my_cart()','core.cart_add(uuid)','core.cart_remove(uuid)','core.cart_clear()',
                             'core.cart_merge(uuid[])','core.cart_quote_inputs(jsonb)']) f
          WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
      );
      const by = (role: string) => rows.filter((x) => x.r === role).map((x) => x.f);
      expect(by("app_web")).toEqual([
        "core.cart_add(uuid)",
        "core.cart_clear()",
        "core.cart_merge(uuid[])",
        "core.cart_remove(uuid)",
        "core.my_cart()",
      ]);
      expect(by("app_pay")).toEqual([
        "core.cart_add(uuid)",
        "core.cart_clear()",
        "core.cart_merge(uuid[])",
        "core.cart_quote_inputs(jsonb)",
        "core.cart_remove(uuid)",
        "core.my_cart()",
      ]);
      expect(rows.filter((x) => x.r !== "app_web" && x.r !== "app_pay")).toEqual([]);
    });
  });

  describe("merge at sign-in", () => {
    it("R2.2: merges eligible products, skips the rest with a reason each, and stops at the limit", async () => {
      const buyer = await user(pool);
      const owned = await seed();
      await payFor(pool, buyer, await checkout(pool, buyer, [owned], standard("SEED")));
      const hidden = await seed();
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [hidden.id]);
      const ok = await Promise.all(Array.from({ length: 3 }, () => seed()));
      const already = await seed();
      await add(buyer, already);
      const missing = uuidv7();
      const r = await cartMerge(pool, {
        authSessionId: buyer.authSessionId,
        productIds: [
          ok[0]?.id,
          hidden.id,
          owned.id,
          already.id,
          ok[1]?.id,
          missing,
          ok[1]?.id,
          ok[2]?.id,
        ] as string[],
      });
      expect(r.cart.lines.map((l) => l.productId)).toEqual([already.id, ok[0]?.id, ok[1]?.id, ok[2]?.id]);
      expect(r.skipped).toEqual([
        { productId: hidden.id, reason: "PRODUCT_UNAVAILABLE" },
        { productId: owned.id, reason: "ALREADY_OWNED" },
        { productId: missing, reason: "PRODUCT_UNAVAILABLE" },
      ]);

      // own company products are skipped; beyond 20 lines the rest is CART_FULL
      const mine = await stocked();
      const many = await Promise.all(Array.from({ length: 17 }, () => seed()));
      const own = await cartMerge(pool, {
        authSessionId: s.owner.authSessionId,
        productIds: [mine.id],
      });
      expect(own.skipped).toEqual([{ productId: mine.id, reason: "SELF_PURCHASE" }]);
      const full = await cartMerge(pool, {
        authSessionId: buyer.authSessionId,
        productIds: many.map((p) => p.id),
      });
      expect(full.cart.lines).toHaveLength(20);
      expect(full.skipped).toEqual(many.slice(16).map((p) => ({ productId: p.id, reason: "CART_FULL" })));
    });

    it("refuses more ids than a cart can hold (VALIDATION_FAILED)", async () => {
      const tooMany = Array.from({ length: 21 }, () => uuidv7());
      expect(await codeOf(cartMerge(pool, { authSessionId: a.authSessionId, productIds: tooMany }))).toBe(
        "VALIDATION_FAILED",
      );
    });
  });

  describe("line issues", () => {
    it("R2.2: a product hidden after being added stays in the cart as UNAVAILABLE", async () => {
      await clear(a);
      const p = await seed();
      await add(a, p);
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [p.id]);
      const [line] = (await myCart(pool, { authSessionId: a.authSessionId })).lines;
      expect(line).toMatchObject({
        productId: p.id,
        name: "Moon Lamp",
        available: false,
        issue: "UNAVAILABLE",
      });
    });

    it("R2.2: a line whose stock ran out shows SOLD_OUT; one the person came to own shows ALREADY_OWNED", async () => {
      await clear(a);
      const scarce = await stocked({ units: 1 });
      await add(a, scarce);
      const other = await user(pool);
      await payFor(pool, other, await checkout(pool, other, [scarce], standard(s)));
      expect((await myCart(pool, { authSessionId: a.authSessionId })).lines[0]).toMatchObject({
        available: false,
        issue: "SOLD_OUT",
      });

      // an owned product in the cart (planted: a purchase itself removes the line)
      const p = await seed();
      await payFor(pool, a, await checkout(pool, a, [p], standard("SEED")));
      await plant(pool, (c) =>
        c.query("INSERT INTO core.cart_line (user_id, product_id) VALUES ($1, $2)", [a.userId, p.id]),
      );
      const owned = (await myCart(pool, { authSessionId: a.authSessionId })).lines.find(
        (l) => l.productId === p.id,
      );
      expect(owned).toMatchObject({ available: true, issue: "ALREADY_OWNED" });
      await clear(a);
    });
  });

  describe("purchase", () => {
    it("US-33: the bought products leave the buyer's cart in the purchase transaction; the rest stays", async () => {
      const buyer = await user(pool);
      const [p1, p2, p3] = await Promise.all([seed(), seed(), stocked()]);
      for (const p of [p1, p2, p3]) await add(buyer, p as ProductFixture);
      // someone else's cart holding the same product is not touched
      await add(b, p1 as ProductFixture);
      await payFor(
        pool,
        buyer,
        await checkout(pool, buyer, [p1, p3] as ProductFixture[], standard("SEED", s)),
      );
      expect(await ids(buyer)).toEqual([p2?.id]);
      expect(await ids(b)).toContain(p1?.id);
      await clear(b);
    });

    it("US-33: a failed payment leaves the cart as it was", async () => {
      const buyer = await user(pool);
      const scarce = await stocked({ units: 1 });
      const p = await seed();
      await add(buyer, scarce);
      await add(buyer, p);
      const co = await checkout(pool, buyer, [scarce, p], standard("SEED", s));
      const other = await user(pool);
      await payFor(pool, other, await checkout(pool, other, [scarce], standard(s)));
      expect(await codeOf(payFor(pool, buyer, co))).toBe("SOLD_OUT");
      expect(await ids(buyer)).toEqual([scarce.id, p.id]);
    });
  });

  describe("preview and checkout from the cart", () => {
    it("the preview prices only purchasable lines, per seller, with STANDARD by default and the balance after", async () => {
      const buyer = await user(pool);
      const p1 = await seed(500n);
      const p2 = await stocked({ rupees: 900n, express: true });
      const gone = await seed();
      for (const p of [p1, p2, gone]) await add(buyer, p);
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [gone.id]);
      const preview = await previewCart(pool, { authSessionId: buyer.authSessionId });
      expect(preview.issues).toEqual([{ productId: gone.id, issue: "UNAVAILABLE" }]);
      expect(preview.sellers.map((x) => [x.sellerKey, x.speed, x.speedsOffered, x.itemTotalPaise])).toEqual([
        ["SEED", "STANDARD", ["STANDARD"], 500n * RUPEE],
        [s.companyId, "STANDARD", ["STANDARD", "EXPRESS"], 900n * RUPEE],
      ]);
      const total = 1_400n * RUPEE + 2n * STANDARD_DELIVERY;
      expect(preview.totalPaise).toBe(total);
      expect(preview.balanceAfterPaise).toBe((preview.balancePaise ?? 0n) - total);
      expect(preview.couponError).toBeNull();
    });

    it("a coupon problem gives the preview without the coupon and a couponError; a good coupon applies", async () => {
      const buyer = await user(pool);
      const p1 = await stocked({ rupees: 1_000n });
      await add(buyer, p1);
      const bad = await previewCart(pool, { authSessionId: buyer.authSessionId, couponCode: "NOPE-NOPE" });
      expect(bad.couponError).toBe("COUPON_INVALID");
      expect(bad.couponCode).toBeNull();
      expect(bad.totalPaise).toBe(1_000n * RUPEE + STANDARD_DELIVERY);
      const coupon = await merchantCoupon(pool, s, { percent: 10 });
      const good = await previewCart(pool, { authSessionId: buyer.authSessionId, couponCode: coupon.code });
      expect(good.couponError).toBeNull();
      expect(good.couponCode).toBe(coupon.code);
      expect(good.sellers[0]?.sellerDiscountPaise).toBe(100n * RUPEE);
      expect(good.totalPaise).toBe(900n * RUPEE + STANDARD_DELIVERY);
      // the failed lookup was counted, as at checkout
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.coupon_lookup_failure WHERE user_id = $1", [
          buyer.userId,
        ]),
      ).toBe(1);
    });

    it("a cart whose options cannot be priced is still returned, with the refusal as previewError", async () => {
      const buyer = await user(pool);
      const cheap = await stocked({ rupees: 450n, freeStd: true, express: true });
      await add(buyer, cheap);
      const r = await cartWithPreview(pool, { authSessionId: buyer.authSessionId });
      expect(r.cart.lines.map((l) => l.productId)).toEqual([cheap.id]);
      expect(r.preview).toBeNull();
      expect(r.previewError?.code).toBe("DELIVERY_UNAVAILABLE");
      expect(await codeOf(previewCart(pool, { authSessionId: buyer.authSessionId }))).toBe(
        "DELIVERY_UNAVAILABLE",
      );
      const express = await previewCart(pool, {
        authSessionId: buyer.authSessionId,
        speedBySeller: { [s.companyId]: "EXPRESS" },
      });
      expect(express.totalPaise).toBe(450n * RUPEE + 10_000n * RUPEE);
    });

    it("a speed a seller does not offer is refused (DELIVERY_UNAVAILABLE)", async () => {
      const buyer = await user(pool);
      await add(buyer, await seed());
      expect(
        await codeOf(
          previewCart(pool, { authSessionId: buyer.authSessionId, speedBySeller: { SEED: "ZAP" } }),
        ),
      ).toBe("DELIVERY_UNAVAILABLE");
    });

    it("US-33: checkout from the cart equals the preview; CART_CHANGED with the issues when a line cannot be bought", async () => {
      const buyer = await user(pool);
      const p1 = await seed(500n);
      const p2 = await stocked({ rupees: 900n, units: 1, express: true });
      await add(buyer, p1);
      await add(buyer, p2);
      const speeds = { [s.companyId]: "EXPRESS" as const };
      const preview = await previewCart(pool, { authSessionId: buyer.authSessionId, speedBySeller: speeds });
      const session = await createCheckoutSessionFromCart(pool, {
        authSessionId: buyer.authSessionId,
        speedBySeller: speeds,
        idempotencyKey: key(),
      });
      expect(session.totalPaise).toBe(preview.totalPaise);
      expect(session.sellers.map((x) => [x.sellerId, x.speed])).toEqual([
        ["SEED", "STANDARD"],
        [s.companyId, "EXPRESS"],
      ]);

      const other = await user(pool);
      await payFor(pool, other, await checkout(pool, other, [p2], standard(s)));
      const refused = createCheckoutSessionFromCart(pool, {
        authSessionId: buyer.authSessionId,
        speedBySeller: speeds,
        idempotencyKey: key(),
      });
      await expect(refused).rejects.toMatchObject({
        code: "CART_CHANGED",
        details: { issues: [{ productId: p2.id, issue: "SOLD_OUT" }] },
      });
      // the session made before the sell-out now fails at pay with no debit
      const attempt = await createPaymentAttempt(pool, {
        authSessionId: buyer.authSessionId,
        sessionId: session.sessionId,
        method: "BALANCE",
      });
      const before = preview.balancePaise;
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: buyer.authSessionId,
            sessionId: session.sessionId,
            attemptId: attempt.attemptId,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("SOLD_OUT");
      expect((await previewCart(pool, { authSessionId: buyer.authSessionId })).balancePaise).toBe(before);
    });

    it("an empty cart cannot be checked out", async () => {
      const buyer = await user(pool);
      expect(
        await codeOf(
          createCheckoutSessionFromCart(pool, { authSessionId: buyer.authSessionId, idempotencyKey: key() }),
        ),
      ).toBe("VALIDATION_FAILED");
      const preview = await previewCart(pool, { authSessionId: buyer.authSessionId });
      expect(preview).toMatchObject({ sellers: [], totalPaise: 0n, issues: [] });
    });

    it("a profile-only user (no wallet) gets a preview without a balance", async () => {
      const id = await createProfile(pool);
      const session = await sessionFor(pool, id);
      await cartAdd(pool, { authSessionId: session, productId: (await seed()).id });
      const preview = await previewCart(pool, { authSessionId: session });
      expect(preview.balancePaise).toBeNull();
      expect(preview.balanceAfterPaise).toBeNull();
      expect(preview.totalPaise).toBe(500n * RUPEE + STANDARD_DELIVERY);
    });
  });

  describe("fifth review: the fee of every offered speed comes with the preview", () => {
    it("US-33: each seller's speedOptions list every offered speed with the fee the preview gives when that speed is chosen", async () => {
      await clear(a);
      const express = await stocked({ express: true, rupees: 900n });
      const plain = await stocked({ rupees: 800n });
      const seeded = await seed(400n);
      for (const p of [express, seeded]) await add(a, p);
      const preview = await previewCart(pool, { authSessionId: a.authSessionId });
      expect(preview.sellers.length).toBe(2);
      for (const s of preview.sellers) {
        expect(s.speedOptions.map((o) => o.speed)).toEqual(s.speedsOffered);
        const current = s.speedOptions.find((o) => o.speed === s.speed);
        expect(current?.deliveryFeePaise).toBe(s.deliveryFeePaise);
        for (const option of s.speedOptions) {
          const chosen = await previewCart(pool, {
            authSessionId: a.authSessionId,
            speedBySeller: { [s.sellerKey]: option.speed },
          });
          const mine = chosen.sellers.find((x) => x.sellerKey === s.sellerKey);
          expect(mine?.deliveryFeePaise, `${s.sellerKey} ${option.speed}`).toBe(option.deliveryFeePaise);
        }
      }
      expect(preview.sellers.find((x) => x.sellerKey === s.companyId)?.speedsOffered).toContain("EXPRESS");
      // a seller whose lines do not all offer Express is offered Standard only
      await add(a, plain);
      const mixed = await previewCart(pool, { authSessionId: a.authSessionId });
      expect(
        mixed.sellers.find((x) => x.sellerKey === s.companyId)?.speedOptions.map((o) => o.speed),
      ).toEqual(["STANDARD"]);
      await clear(a);
    });
  });
});
