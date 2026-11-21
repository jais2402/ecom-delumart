import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCheckoutSession, createPaymentAttempt, markAttemptAuthenticated, pay } from "../src/checkout";
import { SINK_ACCOUNT_ID } from "../src/provision";
import {
  CLEAN,
  CRORE,
  checkout,
  codeOf,
  count,
  journalPostings,
  key,
  LAKH,
  merchantCoupon,
  payFor,
  product,
  RUPEE,
  reconcile,
  reprice,
  STANDARD_DELIVERY,
  seller,
  sinkBalance,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, type TestDatabase } from "./helpers";

const STARTER = 100n * CRORE;

describe("checkout and pay (LLD §5.2)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  const ordersFor = (sessionId: string) =>
    count(pool, "SELECT count(*) AS n FROM core.order_group WHERE session_id = $1", [sessionId]);
  const attemptState = async (attemptId: string) =>
    (
      await pool.query<{ state: string; failure_code: string | null }>(
        "SELECT state, failure_code FROM core.payment_attempt WHERE id = $1",
        [attemptId],
      )
    ).rows[0];

  it("US-03: a seed purchase makes one order group, a balanced journal, ownership, and debits exactly price + ₹1,000 delivery; SINK is credited", async () => {
    const buyer = await user(pool);
    const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 5_000n * RUPEE });
    const sinkBefore = await sinkBalance(pool);
    const co = await checkout(pool, buyer, [p], standard("SEED"));
    expect(co.totalPaise).toBe(5_000n * RUPEE + STANDARD_DELIVERY);

    const receipt = await payFor(pool, buyer, co);

    expect(receipt.totalPaise).toBe(5_000n * RUPEE + STANDARD_DELIVERY);
    expect(receipt.balanceAfterPaise).toBe(STARTER - 5_000n * RUPEE - STANDARD_DELIVERY);
    expect(receipt.paymentReference).toMatch(/^DLP-/);
    expect(receipt.sellers).toEqual([
      { sellerId: "SEED", sellerOrderId: expect.any(String), totalPaise: 5_000n * RUPEE + STANDARD_DELIVERY },
    ]);
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(receipt.balanceAfterPaise);
    expect(await sinkBalance(pool)).toBe(sinkBefore + 5_000n * RUPEE + STANDARD_DELIVERY);
    expect(await ordersFor(co.sessionId)).toBe(1);
    const postings = await journalPostings(pool, receipt.orderGroupId);
    expect(postings).toEqual(
      new Map([
        [buyer.ledgerAccountId, -(5_000n * RUPEE + STANDARD_DELIVERY)],
        [SINK_ACCOUNT_ID, 5_000n * RUPEE + STANDARD_DELIVERY],
      ]),
    );
    expect(
      await count(pool, "SELECT count(*) AS n FROM core.ownership WHERE user_id = $1 AND product_id = $2", [
        buyer.userId,
        p.id,
      ]),
    ).toBe(1);
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM core.shipment s JOIN core.seller_order so ON so.id = s.seller_order_id
          WHERE so.order_group_id = $1 AND s.speed = 'STANDARD'
            AND s.delivered_at - s.placed_at = interval '24 hours'
            AND s.packed_at - s.placed_at = interval '144 minutes'`,
        [receipt.orderGroupId],
      ),
    ).toBe(1);
    expect(await attemptState(co.attemptId)).toEqual({ state: "SUCCEEDED", failure_code: null });
    const outbox = await pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM audit.outbox WHERE type = 'purchase_completed' AND aggregate_id = $1",
      [receipt.orderGroupId],
    );
    expect(outbox.rows).toHaveLength(1);
    const payload = JSON.stringify(outbox.rows[0]?.payload);
    expect(payload).not.toMatch(/email|phone|birth|address|card|pin/i);
  });

  it("US-24: a ₹2 crore player-to-player sale debits the buyer ₹2 crore + delivery, credits the seller ₹1.9 crore and SINK ₹10 lakh + delivery", async () => {
    const buyer = await user(pool);
    const s = await seller(pool);
    const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2n * CRORE, units: 3 });
    const co = await checkout(pool, buyer, [p], standard(s));
    const receipt = await payFor(pool, buyer, co);

    expect(await journalPostings(pool, receipt.orderGroupId)).toEqual(
      new Map([
        [buyer.ledgerAccountId, -(2n * CRORE + STANDARD_DELIVERY)],
        [s.owner.ledgerAccountId, (19n * CRORE) / 10n],
        [SINK_ACCOUNT_ID, 10n * LAKH + STANDARD_DELIVERY],
      ]),
    );
    expect(await wallet(pool, buyer.ledgerAccountId)).toBe(STARTER - 2n * CRORE - STANDARD_DELIVERY);
    expect(await wallet(pool, s.owner.ledgerAccountId)).toBe(STARTER + (19n * CRORE) / 10n);
    const unit = await pool.query<{ serial: number; state: string }>(
      "SELECT serial, state FROM core.inventory_unit WHERE product_id = $1 AND state = 'ISSUED'",
      [p.id],
    );
    expect(unit.rows).toEqual([{ serial: 1, state: "ISSUED" }]);
    const so = await pool.query(
      `SELECT list_paise::text, fee_paise::text, net_paise::text, delivery_fee_buyer_paise::text
         FROM core.seller_order WHERE order_group_id = $1`,
      [receipt.orderGroupId],
    );
    expect(so.rows).toEqual([
      {
        list_paise: (2n * CRORE).toString(),
        fee_paise: (10n * LAKH).toString(),
        net_paise: ((19n * CRORE) / 10n).toString(),
        delivery_fee_buyer_paise: STANDARD_DELIVERY.toString(),
      },
    ]);
  });

  describe("US-33: cart checkout", () => {
    it("US-33: three products from two sellers make one order group, two seller orders and one journal", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const seedP = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 700n * RUPEE });
      const stocked = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 2,
      });
      const exclusive = await product(pool, {
        seller: s,
        mode: "EXCLUSIVE",
        pricePaise: 3_000n * RUPEE,
        units: 5,
      });
      const co = await checkout(pool, buyer, [seedP, stocked, exclusive], standard("SEED", s));
      expect(co.sellers).toHaveLength(2);

      const receipt = await payFor(pool, buyer, co);

      expect(receipt.sellers.map((x) => x.sellerId).sort()).toEqual(["SEED", s.companyId].sort());
      expect(receipt.totalPaise).toBe(4_700n * RUPEE + 2n * STANDARD_DELIVERY);
      expect(await ordersFor(co.sessionId)).toBe(1);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.seller_order WHERE order_group_id = $1", [
          receipt.orderGroupId,
        ]),
      ).toBe(2);
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM ledger.journal WHERE order_group_id = $1 AND event_type = 'PURCHASE'",
          [receipt.orderGroupId],
        ),
      ).toBe(1);
      expect(
        await count(
          pool,
          `SELECT count(*) AS n FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id
            WHERE so.order_group_id = $1`,
          [receipt.orderGroupId],
        ),
      ).toBe(3);
      expect(
        await count(
          pool,
          `SELECT count(*) AS n FROM core.shipment s JOIN core.seller_order so ON so.id = s.seller_order_id
            WHERE so.order_group_id = $1`,
          [receipt.orderGroupId],
        ),
      ).toBe(2);
      const edition = await pool.query<{ edition_serial: number }>(
        "SELECT edition_serial FROM core.order_line WHERE product_id = $1",
        [exclusive.id],
      );
      expect(edition.rows).toEqual([{ edition_serial: 1 }]);
      // seller: Σ(L − F) = 4,000 − 200; SINK: seed 700 + fees 200 + two deliveries
      expect(await journalPostings(pool, receipt.orderGroupId)).toEqual(
        new Map([
          [buyer.ledgerAccountId, -(4_700n * RUPEE + 2n * STANDARD_DELIVERY)],
          [s.owner.ledgerAccountId, 3_800n * RUPEE],
          [SINK_ACCOUNT_ID, 900n * RUPEE + 2n * STANDARD_DELIVERY],
        ]),
      );
    });

    it("US-33: all-or-nothing — one line sells out before pay: refused, no postings, wallets unchanged", async () => {
      const buyer = await user(pool);
      const rival = await user(pool);
      const s = await seller(pool);
      const seedP = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 700n * RUPEE });
      const other = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 2,
      });
      const last = await product(pool, {
        seller: s,
        mode: "EXCLUSIVE",
        pricePaise: 3_000n * RUPEE,
        units: 1,
      });
      const co = await checkout(pool, buyer, [seedP, other, last], standard("SEED", s));
      // the rival takes the last edition first
      await payFor(pool, rival, await checkout(pool, rival, [last], standard(s)));

      const buyerBefore = await wallet(pool, buyer.ledgerAccountId);
      const sellerBefore = await wallet(pool, s.owner.ledgerAccountId);
      const postingsBefore = await count(pool, "SELECT count(*) AS n FROM ledger.posting");
      const outcome = await codeOf(payFor(pool, buyer, co));

      expect(["SOLD_OUT", "CART_CHANGED"]).toContain(outcome);
      expect(await count(pool, "SELECT count(*) AS n FROM ledger.posting")).toBe(postingsBefore);
      expect(await wallet(pool, buyer.ledgerAccountId)).toBe(buyerBefore);
      expect(await wallet(pool, s.owner.ledgerAccountId)).toBe(sellerBefore);
      expect(await ordersFor(co.sessionId)).toBe(0);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.ownership WHERE user_id = $1", [buyer.userId]),
      ).toBe(0);
      expect(await attemptState(co.attemptId)).toEqual({ state: "FAILED", failure_code: outcome });
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE'",
          [other.id],
        ),
      ).toBe(2);
    });
  });

  describe("US-41: merchant coupons", () => {
    it("US-41: a 10% merchant coupon on ₹2 crore debits ₹1.8 crore + delivery, credits the seller ₹1.71 crore and SINK ₹9 lakh + delivery", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const couponId = await merchantCoupon(pool, s, { code: "MONSOON10", percent: 10 });
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 2n * CRORE,
        units: 1,
      });
      const co = await checkout(pool, buyer, [p], standard(s), "monsoon10");
      expect(co.totalPaise).toBe((18n * CRORE) / 10n + STANDARD_DELIVERY);

      const receipt = await payFor(pool, buyer, co);

      expect(await journalPostings(pool, receipt.orderGroupId)).toEqual(
        new Map([
          [buyer.ledgerAccountId, -((18n * CRORE) / 10n + STANDARD_DELIVERY)],
          [s.owner.ledgerAccountId, (171n * CRORE) / 100n],
          [SINK_ACCOUNT_ID, 9n * LAKH + STANDARD_DELIVERY],
        ]),
      );
      const coupon = await pool.query<{ redeemed: number }>(
        "SELECT redeemed FROM core.coupon WHERE id = $1",
        [couponId],
      );
      expect(coupon.rows[0]?.redeemed).toBe(1);
      const redemption = await pool.query(
        "SELECT order_group_id, discount_paise::text FROM core.coupon_redemption WHERE coupon_id = $1",
        [couponId],
      );
      expect(redemption.rows).toEqual([
        { order_group_id: receipt.orderGroupId, discount_paise: ((2n * CRORE) / 10n).toString() },
      ]);
    });

    it("US-41: the company owner cannot redeem their own coupon", async () => {
      const s = await seller(pool);
      await merchantCoupon(pool, s, { code: "OWNERS", percent: 10 });
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 1,
      });
      const outcome = await codeOf(
        createCheckoutSession(pool, {
          authSessionId: s.owner.authSessionId,
          lines: [{ productId: p.id }],
          speedBySeller: standard(s),
          couponCode: "OWNERS",
          idempotencyKey: key(),
        }),
      );
      expect(outcome).toBe("COUPON_NOT_APPLICABLE");
    });

    it("US-41: one redemption per buyer", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      await merchantCoupon(pool, s, { code: "ONCE", percent: 10 });
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
      // two sessions quoted before either is paid: the second is refused at pay
      const first = await checkout(pool, buyer, [p1], standard(s), "ONCE");
      const second = await checkout(pool, buyer, [p2], standard(s), "ONCE");
      await payFor(pool, buyer, first);
      expect(await codeOf(payFor(pool, buyer, second))).toBe("COUPON_NOT_APPLICABLE");
      // and a new quote is refused up front
      expect(await codeOf(checkout(pool, buyer, [p2], standard(s), "ONCE"))).toBe("COUPON_NOT_APPLICABLE");
    });
  });

  describe("US-04: creator threshold", () => {
    it("US-04: paying down to exactly ₹1 crore does NOT unlock", async () => {
      const buyer = await user(pool);
      // ₹100 crore − (₹98,99,99,000 + ₹1,000 delivery) = ₹1,00,00,000 exactly
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 989_999_000n * RUPEE });
      const receipt = await payFor(pool, buyer, await checkout(pool, buyer, [p], standard("SEED")));
      expect(receipt.balanceAfterPaise).toBe(1n * CRORE);
      expect(receipt.creatorUnlocked).toBe(false);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.creator_entitlement WHERE user_id = $1", [
          buyer.userId,
        ]),
      ).toBe(0);
    });

    it("US-04: paying down to ₹99,99,999 unlocks exactly once", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 989_999_001n * RUPEE });
      const receipt = await payFor(pool, buyer, await checkout(pool, buyer, [p], standard("SEED")));
      expect(receipt.balanceAfterPaise).toBe(9_999_999n * RUPEE);
      expect(receipt.creatorUnlocked).toBe(true);
      const ent = await pool.query<{ source: string; evidence_order_group_id: string }>(
        "SELECT source, evidence_order_group_id FROM core.creator_entitlement WHERE user_id = $1",
        [buyer.userId],
      );
      expect(ent.rows).toEqual([
        { source: "PURCHASE_THRESHOLD", evidence_order_group_id: receipt.orderGroupId },
      ]);

      const small = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const again = await payFor(pool, buyer, await checkout(pool, buyer, [small], standard("SEED")));
      expect(again.creatorUnlocked).toBe(false);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.creator_entitlement WHERE user_id = $1", [
          buyer.userId,
        ]),
      ).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("the same key twice returns the same receipt and makes one order", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 500n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      const k = key();
      const first = await payFor(pool, buyer, co, k);
      const second = await payFor(pool, buyer, co, k);
      expect(second).toEqual(first);
      expect(await ordersFor(co.sessionId)).toBe(1);
      expect(await wallet(pool, buyer.ledgerAccountId)).toBe(STARTER - 500n * RUPEE - STANDARD_DELIVERY);
    });

    it("the same key with a different session is a CONFLICT", async () => {
      const buyer = await user(pool);
      const p1 = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 500n * RUPEE });
      const p2 = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 600n * RUPEE });
      const a = await checkout(pool, buyer, [p1], standard("SEED"));
      const b = await checkout(pool, buyer, [p2], standard("SEED"));
      const k = key();
      await payFor(pool, buyer, a, k);
      expect(await codeOf(payFor(pool, buyer, b, k))).toBe("CONFLICT");
      expect(await ordersFor(b.sessionId)).toBe(0);
      expect(await attemptState(b.attemptId)).toEqual({ state: "PENDING", failure_code: null });
    });

    it("a retry after success with a NEW key on the same session does not create a second order (one success per session)", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 500n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      await payFor(pool, buyer, co);
      expect(await codeOf(payFor(pool, buyer, co))).toBe("CONFLICT");
      // a fresh attempt on the paid session is refused too
      expect(
        await codeOf(
          createPaymentAttempt(pool, {
            authSessionId: buyer.authSessionId,
            sessionId: co.sessionId,
            method: "BALANCE",
          }),
        ),
      ).toBe("CONFLICT");
      expect(await ordersFor(co.sessionId)).toBe(1);
      expect(await wallet(pool, buyer.ledgerAccountId)).toBe(STARTER - 500n * RUPEE - STANDARD_DELIVERY);
    });
  });

  describe("refusals: nothing is debited", () => {
    async function expectNothingDebited(
      buyerAccount: string,
      sessionId: string,
      run: () => Promise<string>,
    ): Promise<string> {
      const before = await wallet(pool, buyerAccount);
      const postings = await count(pool, "SELECT count(*) AS n FROM ledger.posting");
      const outcome = await run();
      expect(await wallet(pool, buyerAccount)).toBe(before);
      expect(await count(pool, "SELECT count(*) AS n FROM ledger.posting")).toBe(postings);
      expect(await ordersFor(sessionId)).toBe(0);
      return outcome;
    }

    it("price changed between quote and pay → CART_CHANGED", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 1,
      });
      const co = await checkout(pool, buyer, [p], standard(s));
      await reprice(pool, p, 1_200n * RUPEE);
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, co.sessionId, () =>
        codeOf(payFor(pool, buyer, co)),
      );
      expect(outcome).toBe("CART_CHANGED");
      expect(await attemptState(co.attemptId)).toEqual({ state: "FAILED", failure_code: "CART_CHANGED" });
    });

    it("product hidden between quote and pay → refused", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [p.id]);
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, co.sessionId, () =>
        codeOf(payFor(pool, buyer, co)),
      );
      expect(outcome).toBe("PRODUCT_UNAVAILABLE");
    });

    it("an expired session is refused", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      await pool.query(
        "UPDATE core.checkout_session SET expires_at = now() - interval '1 second' WHERE id = $1",
        [co.sessionId],
      );
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, co.sessionId, () =>
        codeOf(payFor(pool, buyer, co)),
      );
      expect(outcome).toBe("CHECKOUT_EXPIRED");
      expect(await attemptState(co.attemptId)).toEqual({ state: "FAILED", failure_code: "CHECKOUT_EXPIRED" });
    });

    it("an unauthenticated CARD attempt is refused; after the PIN step the same key pays", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const session = await createCheckoutSession(pool, {
        authSessionId: buyer.authSessionId,
        lines: [{ productId: p.id }],
        speedBySeller: standard("SEED"),
        idempotencyKey: key(),
      });
      const attempt = await createPaymentAttempt(pool, {
        authSessionId: buyer.authSessionId,
        sessionId: session.sessionId,
        method: "CARD",
        cardId: buyer.cardId,
      });
      expect(attempt.authenticated).toBe(false);
      const k = key();
      const input = {
        authSessionId: buyer.authSessionId,
        sessionId: session.sessionId,
        attemptId: attempt.attemptId,
        idempotencyKey: k,
      };
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, session.sessionId, () =>
        codeOf(pay(pool, input)),
      );
      expect(outcome).toBe("PAYMENT_PENDING");
      expect(await attemptState(attempt.attemptId)).toEqual({ state: "PENDING", failure_code: null });

      await markAttemptAuthenticated(pool, {
        authSessionId: buyer.authSessionId,
        attemptId: attempt.attemptId,
      });
      const receipt = await pay(pool, input);
      expect(receipt.paymentReference).toBe(attempt.reference);
    });

    it("a frozen card is refused, at attempt creation and at pay", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const session = await createCheckoutSession(pool, {
        authSessionId: buyer.authSessionId,
        lines: [{ productId: p.id }],
        speedBySeller: standard("SEED"),
        idempotencyKey: key(),
      });
      const attempt = await createPaymentAttempt(pool, {
        authSessionId: buyer.authSessionId,
        sessionId: session.sessionId,
        method: "CARD",
        cardId: buyer.cardId,
      });
      await markAttemptAuthenticated(pool, {
        authSessionId: buyer.authSessionId,
        attemptId: attempt.attemptId,
      });
      await pool.query("UPDATE core.virtual_card SET status = 'FROZEN' WHERE id = $1", [buyer.cardId]);
      try {
        const outcome = await expectNothingDebited(buyer.ledgerAccountId, session.sessionId, () =>
          codeOf(
            pay(pool, {
              authSessionId: buyer.authSessionId,
              sessionId: session.sessionId,
              attemptId: attempt.attemptId,
              idempotencyKey: key(),
            }),
          ),
        );
        expect(outcome).toBe("CARD_FROZEN");
        expect(
          await codeOf(
            createPaymentAttempt(pool, {
              authSessionId: buyer.authSessionId,
              sessionId: session.sessionId,
              method: "CARD",
              cardId: buyer.cardId,
            }),
          ),
        ).toBe("CARD_FROZEN");
      } finally {
        await pool.query("UPDATE core.virtual_card SET status = 'ACTIVE' WHERE id = $1", [buyer.cardId]);
      }
    });

    it("another user's card is refused", async () => {
      const buyer = await user(pool);
      const other = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const session = await createCheckoutSession(pool, {
        authSessionId: buyer.authSessionId,
        lines: [{ productId: p.id }],
        speedBySeller: standard("SEED"),
        idempotencyKey: key(),
      });
      expect(
        await codeOf(
          createPaymentAttempt(pool, {
            authSessionId: buyer.authSessionId,
            sessionId: session.sessionId,
            method: "CARD",
            cardId: other.cardId,
          }),
        ),
      ).toBe("CARD_NOT_OWNED");
    });

    it("purchases switch off → refused", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'purchases'");
      try {
        const outcome = await expectNothingDebited(buyer.ledgerAccountId, co.sessionId, () =>
          codeOf(payFor(pool, buyer, co)),
        );
        expect(outcome).toBe("MAINTENANCE");
      } finally {
        await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'purchases'");
      }
    });

    it("a missing purchases switch → refused", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      await pool.query("DELETE FROM core.system_switch WHERE name = 'purchases'");
      try {
        expect(await codeOf(payFor(pool, buyer, co))).toBe("MAINTENANCE");
        expect(await ordersFor(co.sessionId)).toBe(0);
      } finally {
        await pool.query(
          "INSERT INTO core.system_switch (name, enabled, updated_at) VALUES ('purchases', true, now())",
        );
      }
    });

    it("INSUFFICIENT_FUNDS leaves everything unchanged, records a FAILED attempt and replays under the same key", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * CRORE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      expect(co.totalPaise).toBe(STARTER + STANDARD_DELIVERY);
      const k = key();
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, co.sessionId, () =>
        codeOf(payFor(pool, buyer, co, k)),
      );
      expect(outcome).toBe("INSUFFICIENT_FUNDS");
      expect(await attemptState(co.attemptId)).toEqual({
        state: "FAILED",
        failure_code: "INSUFFICIENT_FUNDS",
      });
      expect(await codeOf(payFor(pool, buyer, co, k))).toBe("INSUFFICIENT_FUNDS");
      const stored = await pool.query<{ status: number; response: { error: { code: string } } }>(
        "SELECT status, response FROM core.idempotency_record WHERE user_id = $1 AND command = 'pay' AND key = $2",
        [buyer.userId, k],
      );
      expect(stored.rows[0]?.status).toBe(422);
      expect(stored.rows[0]?.response.error.code).toBe("INSUFFICIENT_FUNDS");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.ownership WHERE user_id = $1", [buyer.userId]),
      ).toBe(0);
      expect(
        await count(pool, "SELECT count(*) AS n FROM audit.outbox WHERE payload->>'sessionId' = $1", [
          co.sessionId,
        ]),
      ).toBe(0);
    });

    it("an already-owned product is rejected at quote and at pay", async () => {
      const buyer = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const first = await checkout(pool, buyer, [p], standard("SEED"));
      const second = await checkout(pool, buyer, [p], standard("SEED"));
      await payFor(pool, buyer, first);
      const outcome = await expectNothingDebited(buyer.ledgerAccountId, second.sessionId, () =>
        codeOf(payFor(pool, buyer, second)),
      );
      expect(outcome).toBe("ALREADY_OWNED");
      expect(await codeOf(checkout(pool, buyer, [p], standard("SEED")))).toBe("ALREADY_OWNED");
    });

    it("self-purchase (the buyer owns the selling company) is rejected", async () => {
      const s = await seller(pool);
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 1,
      });
      expect(await codeOf(checkout(pool, s.owner, [p], standard(s)))).toBe("SELF_PURCHASE");
    });

    it("unpublished and sold-out products are rejected at quote; more than 20 lines is refused", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const draft = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 1,
      });
      await pool.query("UPDATE core.product SET status = 'DRAFT' WHERE id = $1", [draft.id]);
      expect(await codeOf(checkout(pool, buyer, [draft], standard(s)))).toBe("PRODUCT_UNAVAILABLE");

      const gone = await product(pool, {
        seller: s,
        mode: "EXCLUSIVE",
        pricePaise: 1_000n * RUPEE,
        units: 1,
      });
      const rival = await user(pool);
      await payFor(pool, rival, await checkout(pool, rival, [gone], standard(s)));
      expect(await codeOf(checkout(pool, buyer, [gone], standard(s)))).toBe("SOLD_OUT");

      const many = await Promise.all(
        Array.from({ length: 21 }, () => product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE })),
      );
      expect(await codeOf(checkout(pool, buyer, many, standard("SEED")))).toBe("VALIDATION_FAILED");
      const twenty = await checkout(pool, buyer, many.slice(0, 20), standard("SEED"));
      expect(twenty.totalPaise).toBe(2_000n * RUPEE + STANDARD_DELIVERY);
    });

    it("another user's session cannot be paid", async () => {
      const buyer = await user(pool);
      const thief = await user(pool);
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE });
      const co = await checkout(pool, buyer, [p], standard("SEED"));
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: thief.authSessionId,
            sessionId: co.sessionId,
            attemptId: co.attemptId,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await attemptState(co.attemptId)).toEqual({ state: "PENDING", failure_code: null });
    });
  });
});
