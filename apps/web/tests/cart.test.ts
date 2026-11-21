import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkout as dbCheckout,
  merchantCoupon,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  type Seller,
  seller,
  standard,
  user,
} from "../../../packages/db/tests/checkout-fixtures";
import * as cartLineRoute from "../src/app/api/v1/cart/lines/[productId]/route";
import * as cartLines from "../src/app/api/v1/cart/lines/route";
import * as cartMerge from "../src/app/api/v1/cart/merge/route";
import * as cartPreview from "../src/app/api/v1/cart/preview/route";
import * as cartRoute from "../src/app/api/v1/cart/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";

/** PRD R2.2 cart and US-33 cart checkout, through the route handlers against a throwaway database. */
let app: TestApp;
let s: Seller;
/** The user seller's products (stocked, plenty of units), some offering Express. */
let sellerProducts: ProductFixture[];
let percentCoupon: string;
const FLAT_MIN_SPEND_CODE = "BIGSPENDER";

beforeAll(async () => {
  // the property test below makes ~100 checkout and coupon calls per minute as one player: far
  // beyond the per-account production limits, which other test files assert at their real values
  app = await startTestApp({ env: { RATE_LIMIT_MULTIPLIER: "100" } });
  const pool = app.db.pool;
  s = await seller(pool);
  sellerProducts = [];
  for (const [i, rupees] of [700n, 1_200n, 450n, 2_500n].entries()) {
    sellerProducts.push(
      await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: rupees * RUPEE,
        units: 20,
        express: i % 2 === 0,
        freeStd: i >= 2, // the ₹450 one alone cannot fund ₹1,000 Standard delivery
      }),
    );
  }
  percentCoupon = (await merchantCoupon(pool, s, { percent: 15 })).code;
  // a FLAT ₹300 coupon from ₹3,000 of this seller's items: below that it does not apply
  await pool.query(
    `INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value, min_spend_paise, is_public)
     VALUES (gen_random_uuid(), 'MERCHANT', $1, $2, false, 'FLAT', 30000, 300000, true)`,
    [s.companyId, FLAT_MIN_SPEND_CODE],
  );
}, 180_000);

afterAll(async () => {
  await app.stop();
});

// ------------------------------------------------------------------ calls

const getCart = (b: Browser) => b.call(cartRoute.GET, "GET", "/api/v1/cart");
const addLine = (b: Browser, productId: string) =>
  b.call(cartLines.POST, "POST", "/api/v1/cart/lines", { body: { productId } });
const removeLine = (b: Browser, productId: string) =>
  b.call(cartLineRoute.DELETE, "DELETE", `/api/v1/cart/lines/${productId}`, { params: { productId } });
const clearCart = (b: Browser) => b.call(cartRoute.DELETE, "DELETE", "/api/v1/cart");
const merge = (b: Browser, productIds: string[]) =>
  b.call(cartMerge.POST, "POST", "/api/v1/cart/merge", { body: { productIds } });
const preview = (b: Browser, body: Record<string, unknown> = {}) =>
  b.call(cartPreview.POST, "POST", "/api/v1/cart/preview", { body });
const checkoutCart = (b: Browser, body: Record<string, unknown> = {}, key: string | boolean = true) =>
  b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: { source: "CART", ...body },
    idempotencyKey: key,
  });
const balanceOf = async (b: Browser): Promise<bigint> =>
  BigInt(str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise));

function lineIds(res: CallResult): string[] {
  return arr(res.json.groups).flatMap((g) => arr(g.lines).map((l) => str(l.productId)));
}

const seedIds = () => app.products.map((p) => p.id);

function expectPrivate(res: CallResult): void {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

// ------------------------------------------------------------------ tests

describe("cart routes", () => {
  it("R2.2: add, remove, clear; the response groups lines by seller with a priced preview", async () => {
    const { b } = await player({ pin: false });
    const [p1, p2] = seedIds();
    const sp = sellerProducts[0] as ProductFixture;
    const empty = await getCart(b);
    expect(empty.status).toBe(200);
    expectPrivate(empty);
    expect(empty.json).toMatchObject({ lineCount: 0, maxLines: 20, groups: [] });
    expect(empty.json.preview).toMatchObject({ sellers: [], totalPaise: "0", issues: [] });

    await addLine(b, str(p1));
    const added = await addLine(b, sp.id);
    expect(added.status).toBe(200);
    expectPrivate(added);
    await addLine(b, str(p2));
    const res = await addLine(b, str(p1)); // already there: no-op
    expect(res.json.lineCount).toBe(3);
    expect(arr(res.json.groups).map((g) => [g.sellerKey, g.sellerName, arr(g.lines).length])).toEqual([
      ["SEED", "DeluluMart Originals", 2],
      [s.companyId, expect.any(String), 1],
    ]);
    const line = arr(arr(res.json.groups)[1]?.lines)[0];
    expect(line).toMatchObject({
      productId: sp.id,
      pricePaise: (700n * RUPEE).toString(),
      available: true,
      offersExpress: true,
      issue: null,
    });
    expect(Object.keys(line ?? {}).sort()).toEqual(
      [
        "addedAt",
        "altText",
        "available",
        "category",
        "freeStandardDelivery",
        "hook",
        "issue",
        "name",
        "offersExpress",
        "pricePaise",
        "productId",
        "templateId",
        "versionId",
        "zapAvailable",
      ].sort(),
    );
    const sellers = arr(res.json.preview?.sellers);
    expect(sellers.map((x) => [x.sellerKey, x.speed])).toEqual([
      ["SEED", "STANDARD"],
      [s.companyId, "STANDARD"],
    ]);
    expect(arr(sellers[1]?.speedsOffered)).toEqual(["STANDARD", "EXPRESS"]);
    const seedTotal = (app.products[0]?.pricePaise ?? 0n) + (app.products[1]?.pricePaise ?? 0n);
    const expected = seedTotal + 700n * RUPEE + 2n * 1_000n * RUPEE;
    expect(res.json.preview?.totalPaise).toBe(expected.toString());
    const balance = BigInt(str(res.json.preview?.balancePaise));
    expect(res.json.preview?.balanceAfterPaise).toBe((balance - expected).toString());

    const removed = await removeLine(b, str(p1));
    expect(removed.status).toBe(200);
    expect(lineIds(removed)).toEqual([sp.id, str(p2)]); // grouped by seller, first added first
    const cleared = await clearCart(b);
    expect(cleared.status).toBe(200);
    expect(cleared.json.lineCount).toBe(0);
  });

  it("R2.2: a cart whose default delivery cannot be priced is still shown, with previewError", async () => {
    const { b } = await player({ pin: false });
    const cheapFree = sellerProducts[2] as ProductFixture; // ₹450, merchant-paid Standard delivery
    const res = await addLine(b, cheapFree.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ lineCount: 1, preview: null, previewError: "DELIVERY_UNAVAILABLE" });
    const express = await preview(b, { speedBySeller: { [s.companyId]: "EXPRESS" } });
    expect(express.status).toBe(200);
    expect(express.json.totalPaise).toBe((450n * RUPEE + 10_000n * RUPEE).toString());
  });

  it("R2.2: a refused add carries its stable code; a malformed id or path is refused before the database", async () => {
    const { b } = await player({ pin: false });
    const missing = await addLine(b, randomUUID());
    expect(missing.status).toBe(409);
    expect(missing.json.error?.code).toBe("PRODUCT_UNAVAILABLE");
    expect((await addLine(b, "not-a-uuid")).status).toBe(400);
    expect((await removeLine(b, "not-a-uuid")).status).toBe(404);
  });

  it("R2.2: merge at sign-in adds eligible products and reports skipped ones with a reason", async () => {
    const { b } = await player({ pin: false });
    const [p1, p2] = seedIds();
    await addLine(b, str(p1));
    const missing = randomUUID();
    const res = await merge(b, [str(p1), str(p2), missing, (sellerProducts[1] as ProductFixture).id]);
    expect(res.status).toBe(200);
    expectPrivate(res);
    expect(lineIds(res)).toEqual([str(p1), str(p2), (sellerProducts[1] as ProductFixture).id]);
    expect(res.json.skipped).toEqual([{ productId: missing, reason: "PRODUCT_UNAVAILABLE" }]);
    const tooMany = await merge(
      b,
      Array.from({ length: 21 }, () => randomUUID()),
    );
    expect(tooMany.status).toBe(400);
  });

  it("R2.2: a person cannot add their own company's products (SELF_PURCHASE)", async () => {
    const { b } = await player({ pin: false });
    const pool = app.db.pool;
    const owner = await pool.query<{ user_id: string }>("SELECT user_id FROM auth.sessions WHERE id = $1", [
      b.cookie("__Host-dm_session"),
    ]);
    const companyId = randomUUID();
    const warehouseId = randomUUID();
    await pool.query("INSERT INTO core.company (id, owner_user_id, name) VALUES ($1, $2, 'My Own Shop')", [
      companyId,
      owner.rows[0]?.user_id,
    ]);
    await pool.query(
      "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'STARTER', 100, 0)",
      [warehouseId, companyId],
    );
    const mine = await product(pool, {
      seller: { owner: s.owner, companyId, warehouseId },
      mode: "STANDARD_STOCKED",
      pricePaise: 500n * RUPEE,
    });
    const res = await addLine(b, mine.id);
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe("SELF_PURCHASE");
    expect((await getCart(b)).json.lineCount).toBe(0);
  });

  it("every cart route needs a session (401) and is private", async () => {
    const anon = new Browser();
    const token = await anon.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    anon.csrfToken = str(token.json.csrfToken);
    const id = str(seedIds()[0]);
    for (const res of [
      await getCart(anon),
      await addLine(anon, id),
      await removeLine(anon, id),
      await clearCart(anon),
      await merge(anon, [id]),
      await preview(anon),
      await checkoutCart(anon),
    ]) {
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe("AUTH_REQUIRED");
      expectPrivate(res);
    }
  });

  it("CSRF is enforced on every cart write (no token, wrong token, foreign Origin)", async () => {
    const { b } = await player({ pin: false });
    const id = str(seedIds()[0]);
    const writes: [Parameters<Browser["call"]>[0], string, string, Record<string, unknown> | undefined][] = [
      [cartLines.POST, "POST", "/api/v1/cart/lines", { productId: id }],
      [cartLineRoute.DELETE, "DELETE", `/api/v1/cart/lines/${id}`, undefined],
      [cartRoute.DELETE, "DELETE", "/api/v1/cart", undefined],
      [cartMerge.POST, "POST", "/api/v1/cart/merge", { productIds: [id] }],
      [cartPreview.POST, "POST", "/api/v1/cart/preview", {}],
    ];
    for (const [handler, method, path, body] of writes) {
      for (const guard of [{ csrf: false }, { csrf: "wrong-token" }, { origin: "https://evil.test" }]) {
        const res = await b.call(handler, method, path, {
          ...(body === undefined ? {} : { body }),
          params: { productId: id },
          ...guard,
        });
        expect(res.status, `${method} ${path} ${JSON.stringify(guard)}`).toBe(403);
      }
    }
    expect((await getCart(b)).json.lineCount).toBe(0);
  });

  it("user B can neither read nor alter user A's cart", async () => {
    const a = (await player({ pin: false })).b;
    const b = (await player({ pin: false })).b;
    const [p1, p2] = seedIds();
    await addLine(a, str(p1));
    await addLine(b, str(p2));
    const seenByB = await getCart(b);
    expect(lineIds(seenByB)).toEqual([str(p2)]);
    expect(seenByB.text).not.toContain(str(p1));
    await removeLine(b, str(p1));
    await clearCart(b);
    expect(lineIds(await getCart(a))).toEqual([str(p1)]);
    // a checkout from B's (now empty) cart never reaches A's lines
    const co = await checkoutCart(b);
    expect(co.status).toBe(422);
    expect(lineIds(await getCart(a))).toEqual([str(p1)]);
  });
});

describe("preview and checkout agree", () => {
  it("R2.2 US-33: for 50 random carts the preview total equals the checkout session's total", async () => {
    const { b } = await player({ pin: false });
    const pool = [...seedIds(), ...sellerProducts.map((p) => p.id)];
    let withCoupon = 0;
    let couponErrors = 0;
    let refusals = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(pool, { minLength: 1 }),
        fc.array(fc.nat(), { minLength: 2, maxLength: 2 }),
        fc.constantFrom(null, "PERCENT", "FLAT"),
        async (productIds, speedPicks, couponKind) => {
          await clearCart(b);
          for (const id of productIds) {
            const added = await addLine(b, id);
            expect(added.status, added.text).toBe(200);
          }
          const base = await getCart(b);
          expect(base.status).toBe(200);
          const speedBySeller: Record<string, string> = {};
          if (base.json.preview === null) {
            // the default options cannot be priced; the cart is still shown
            expect(base.json.previewError).toBe("DELIVERY_UNAVAILABLE");
            for (const g of arr(base.json.groups)) speedBySeller[str(g.sellerKey)] = "STANDARD";
          } else {
            arr(base.json.preview?.sellers).forEach((x, i) => {
              const offered = arr(x.speedsOffered).map(str);
              speedBySeller[str(x.sellerKey)] = offered[(speedPicks[i] ?? 0) % offered.length] ?? "STANDARD";
            });
          }
          const hasSellerLines = productIds.some((id) => sellerProducts.some((p) => p.id === id));
          const couponCode =
            couponKind === null || !hasSellerLines
              ? undefined
              : couponKind === "PERCENT"
                ? percentCoupon
                : FLAT_MIN_SPEND_CODE;
          const options = { speedBySeller, ...(couponCode ? { couponCode } : {}) };
          const quoted = await preview(b, options);
          const session = await checkoutCart(b, options);
          if (couponCode) withCoupon += 1;
          if (quoted.status !== 200) {
            // options the pricing function refuses are refused by checkout with the same code
            refusals += 1;
            expect(quoted.status).toBe(422);
            expect(session.status).toBe(422);
            expect(session.json.error?.code).toBe(quoted.json.error?.code);
          } else if (quoted.json.couponError === null) {
            expect(session.status).toBe(201);
            expect(session.json.totalPaise).toBe(quoted.json.totalPaise);
            expect(arr(session.json.sellers).map((x) => [x.sellerId, x.speed, x.totalPaise])).toEqual(
              arr(quoted.json.sellers).map((x) => [x.sellerKey, x.speed, x.totalPaise]),
            );
            if (couponCode) expect(quoted.json.couponCode).toBe(couponCode);
          } else {
            // the coupon problem the preview reported is the one checkout refuses with
            couponErrors += 1;
            expect(session.status).toBe(422);
            expect(session.json.error?.code).toBe(quoted.json.couponError);
          }
        },
      ),
      { numRuns: 50, seed: 20261121 },
    );
    expect(withCoupon).toBeGreaterThan(0);
    expect(couponErrors).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  }, 300_000);
});

describe("US-33 cart checkout", () => {
  it("US-33: three products from two sellers → one order group, two seller orders, one balanced journal, cart empty; a repeated pay returns the same order", async () => {
    const { b } = await player({ pin: false });
    const [p1, p2] = seedIds();
    const sp = sellerProducts[3] as ProductFixture;
    for (const id of [str(p1), str(p2), sp.id]) await addLine(b, id);
    const before = await balanceOf(b);
    const quoted = await preview(b, {});
    const session = await checkoutCart(b, { speedBySeller: { SEED: "STANDARD", [s.companyId]: "STANDARD" } });
    expect(session.status).toBe(201);
    expect(session.json.totalPaise).toBe(quoted.json.totalPaise);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "BALANCE" },
    });
    expect(attempt.status).toBe(201);
    const attemptId = str(attempt.json.id);
    const key = randomUUID();
    const pay = () =>
      b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
        params: { id: sessionId },
        body: { attemptId },
        idempotencyKey: key,
      });
    const paid = await pay();
    expect(paid.status).toBe(200);
    const orderId = str(paid.json.orderId);
    const total = BigInt(str(paid.json.totalPaise));
    expect(total.toString()).toBe(quoted.json.totalPaise);
    expect(arr(paid.json.sellers)).toHaveLength(2);

    const db = app.db.pool;
    const groups = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.order_group WHERE session_id = $1",
      [sessionId],
    );
    expect(groups.rows[0]?.n).toBe(1);
    const sellerOrders = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.seller_order WHERE order_group_id = $1",
      [orderId],
    );
    expect(sellerOrders.rows[0]?.n).toBe(2);
    const journal = await db.query<{ journals: number; sum: string; buyer: string }>(
      `SELECT count(DISTINCT p.journal_id)::int AS journals, sum(p.amount)::text AS sum,
              sum(p.amount) FILTER (WHERE p.amount < 0 AND la.type = 'USER')::text AS buyer
         FROM ledger.posting p JOIN ledger.ledger_account la ON la.id = p.account_id
        WHERE p.journal_id = (SELECT journal_id FROM core.order_group WHERE id = $1)`,
      [orderId],
    );
    expect(journal.rows[0]).toEqual({ journals: 1, sum: "0", buyer: (-total).toString() });
    const attempts = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.payment_attempt WHERE session_id = $1 AND state = 'SUCCEEDED'",
      [sessionId],
    );
    expect(attempts.rows[0]?.n).toBe(1);

    expect(await balanceOf(b)).toBe(before - total);
    const after = await getCart(b);
    expect(after.json.lineCount).toBe(0);

    const replay = await pay();
    expect(replay.status).toBe(200);
    expect(replay.json.orderId).toBe(orderId);
    expect(await balanceOf(b)).toBe(before - total);
  });

  it("US-33: a line that sells out between preview and pay: nothing is debited, the response and the cart show the issue", async () => {
    const pool = app.db.pool;
    const scarce = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 900n * RUPEE,
      units: 1,
    });
    const { b } = await player({ pin: false });
    const seedId = str(seedIds()[2]);
    await addLine(b, seedId);
    await addLine(b, scarce.id);
    const quoted = await preview(b, {});
    expect(quoted.json.issues).toEqual([]);
    const session = await checkoutCart(b, {});
    expect(session.status).toBe(201);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "BALANCE" },
    });
    const attemptId = str(attempt.json.id);
    const before = await balanceOf(b);

    // someone else buys the last unit
    const other = await user(pool);
    await payFor(pool, other, await dbCheckout(pool, other, [scarce], standard(s)));

    const key = randomUUID();
    const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: key,
    });
    expect(paid.status).toBe(409);
    expect(paid.json.error?.code).toBe("SOLD_OUT");
    expect(paid.json.error?.details?.issues).toEqual([{ productId: scarce.id, issue: "SOLD_OUT" }]);
    expect(await balanceOf(b)).toBe(before);
    const orders = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.order_group WHERE session_id = $1",
      [sessionId],
    );
    expect(orders.rows[0]?.n).toBe(0);

    // the cart keeps both lines and shows the change; checking it out again is CART_CHANGED
    const cart = await getCart(b);
    expect(lineIds(cart)).toEqual([seedId, scarce.id]);
    expect(cart.json.preview?.issues).toEqual([{ productId: scarce.id, issue: "SOLD_OUT" }]);
    const again = await checkoutCart(b, {});
    expect(again.status).toBe(409);
    expect(again.json.error?.code).toBe("CART_CHANGED");
    expect(again.json.error?.details?.issues).toEqual([{ productId: scarce.id, issue: "SOLD_OUT" }]);
    // the same pay request replays the same failure
    const replay = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId },
      idempotencyKey: key,
    });
    expect(replay.json.error?.code).toBe("SOLD_OUT");
    expect(await balanceOf(b)).toBe(before);
  });

  it("checkout from the cart validates its options strictly", async () => {
    const { b } = await player({ pin: false });
    await addLine(b, str(seedIds()[0]));
    const bad = await checkoutCart(b, { speedBySeller: { SEED: "TELEPORT" } });
    expect(bad.status).toBe(400);
    const extra = await checkoutCart(b, { lines: [] });
    expect(extra.status).toBe(400);
    const zap = await preview(b, { speedBySeller: { SEED: "ZAP" } });
    const offered = arr(arr((await getCart(b)).json.preview?.sellers)[0]?.speedsOffered).map(str);
    expect(zap.status).toBe(offered.includes("ZAP") ? 200 : 422);
  });

  it("US-33 (fifth review): the preview names every offered speed's delivery fee, each equal to the fee when that speed is chosen", async () => {
    const { b } = await player({ pin: false });
    await addLine(b, str(seedIds()[0]));
    await addLine(b, (sellerProducts[0] as ProductFixture).id); // offers Express
    const res = await preview(b);
    expect(res.status).toBe(200);
    for (const seller of arr(res.json.sellers)) {
      const options = arr(seller.speedOptions);
      expect(options.map((o) => str(o.speed))).toEqual(arr(seller.speedsOffered).map(str));
      for (const option of options) {
        expect(str(option.deliveryFeePaise)).toMatch(/^\d+$/);
        const chosen = await preview(b, { speedBySeller: { [str(seller.sellerKey)]: str(option.speed) } });
        const mine = arr(chosen.json.sellers).find((x) => x.sellerKey === seller.sellerKey);
        expect(str(mine?.deliveryFeePaise)).toBe(str(option.deliveryFeePaise));
      }
    }
    const express = arr(res.json.sellers).find((x) => String(x.sellerKey) === s.companyId);
    expect(arr(express?.speedOptions).map((o) => str(o.speed))).toEqual(["STANDARD", "EXPRESS"]);
    // GET /cart carries them too
    const cart = await getCart(b);
    expect(arr(arr(cart.json.preview?.sellers)[1]?.speedOptions).length).toBe(2);
  });
});
