import { randomBytes } from "node:crypto";
import { DEFAULT_DELIVERY_DURATIONS_MS, DEFAULT_PRICING_CONFIG, price } from "@delulu/core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCheckoutSession, createPaymentAttempt, markAttemptAuthenticated, pay } from "../src/checkout";
import { MINT_ACCOUNT_ID, type ProvisionResult, SINK_ACCOUNT_ID } from "../src/provision";
import { type TransactionOptions, withTransaction } from "../src/transaction";
import {
  CLEAN,
  CRORE,
  checkout,
  codeOf,
  count,
  key,
  merchantCoupon,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  reconcile,
  reprice,
  type Seller,
  seller,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  asActor,
  commitError,
  commitState,
  countRows,
  createTestDatabase,
  plant,
  provisionAccount,
  provisionInput,
  sqlState,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

/**
 * Security review of the money path, replayed. Each attack is run first as app_web (the
 * ordinary web role: must be denied by privilege) and then as app_pay, the money-command
 * role, with raw SQL (must be denied by the structural rules of migration 0016, which hold
 * even if the web process and so its app_pay credential are compromised).
 */
const RELIEF = 100_000_000n;
const DELIVERY = { STANDARD: 1_000n * RUPEE, EXPRESS: 10_000n * RUPEE, ZAP: 50_000n * RUPEE } as const;
type Speed = keyof typeof DELIVERY;

const web = (u: ProvisionResult): Actor => ({ role: "app_web", userId: u.userId });
const payAs = (u: ProvisionResult): Actor => ({ role: "app_pay", userId: u.userId });

describe("money attacks (security review)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let buyer: ProvisionResult;
  let s: Seller;
  let crorePiece: ProductFixture; // ₹10 crore, stocked
  let couponId: string;
  let accomplice: ProvisionResult;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    buyer = await user(pool);
    s = await seller(pool);
    crorePiece = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 10n * CRORE,
      units: 3,
    });
    couponId = await merchantCoupon(pool, s, { code: "TENOFF", percent: 10 });
    accomplice = await user(pool);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A user provisioned while tombstoned: wallet 0, no STARTER grant (eligible for relief). */
  async function poorUser(): Promise<ProvisionResult> {
    const input = provisionInput();
    await pool.query(
      "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '30 days')",
      [input.emailFingerprint],
    );
    return provisionAccount(pool, input);
  }

  /** A balanced journal of `type` with the given postings; touched USER wallets are synced. */
  async function journal(
    c: pg.PoolClient,
    type: string,
    postings: [string, bigint][],
    extra: (journalId: string) => Promise<unknown> = async () => undefined,
  ): Promise<string> {
    const j = uuidv7();
    await c.query("INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)", [
      j,
      type,
    ]);
    for (const [account, amount] of postings) {
      await c.query(
        "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
        [j, account, amount.toString()],
      );
    }
    await extra(j);
    const users = postings.map(([a]) => a).filter((a) => a !== MINT_ACCOUNT_ID && a !== SINK_ACCOUNT_ID);
    await c.query("SELECT ledger.sync_wallets($1)", [users]);
    return j;
  }

  const relief = (c: pg.PoolClient, who: ProvisionResult, amount: bigint) =>
    journal(
      c,
      "RELIEF_GRANT",
      [
        [MINT_ACCOUNT_ID, -amount],
        [who.ledgerAccountId, amount],
      ],
      (j) =>
        c.query(
          `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
           VALUES ($1, $2, $3, 'RELIEF', $4, (now() AT TIME ZONE 'UTC')::date)`,
          [uuidv7(), who.userId, j, amount.toString()],
        ),
    );

  /** An OPEN checkout session of `who` whose quote names the coupon (as a real quote does). */
  const nameCoupon = (c: pg.PoolClient, who: ProvisionResult, id: string) =>
    c.query(
      `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
       VALUES ($1, $2, 'PRODUCT_PURCHASE', $3, 1, 1, now() + interval '5 minutes')`,
      [uuidv7(), who.userId, JSON.stringify({ coupon: { id } })],
    );

  // -------------------------------------------------------------------------------- (1) minting
  describe("attack 1: minting money", () => {
    for (const type of ["COMPANY_REGISTRATION", "WAREHOUSE_PURCHASE", "MEMBERSHIP", "PURCHASE"]) {
      it(`a ${type} journal posting MINT -> self: app_web has no privilege, app_pay is refused`, async () => {
        const mint = (c: pg.PoolClient) =>
          journal(c, type, [
            [MINT_ACCOUNT_ID, -CRORE],
            [buyer.ledgerAccountId, CRORE],
          ]);
        expect(await commitState(pool, web(buyer), mint)).toBe("42501");
        if (type === "PURCHASE") {
          expect(await commitError(pool, payAs(buyer), mint)).toMatch(
            /PURCHASE journal .* may not post to MINT/,
          );
        } else {
          // unbacked types are refused to app_pay outright (finding 9); the account rule still
          // holds for the path they will take once backed (here: the owner acting for the buyer)
          expect(await commitState(pool, payAs(buyer), mint)).toBe("42501");
          expect(await commitError(pool, { userId: buyer.userId }, mint)).toMatch(
            new RegExp(`${type} journal .* may not post to MINT`),
          );
        }
      });
    }

    it("an uncapped RELIEF_GRANT is refused: relief is exactly ₹10 lakh (100,000,000 paise)", async () => {
      const poor = await poorUser();
      expect(await commitState(pool, web(poor), (c) => relief(c, poor, 100n * CRORE))).toBe("42501");
      expect(await commitError(pool, payAs(poor), (c) => relief(c, poor, 100n * CRORE))).toMatch(
        /RELIEF_GRANT is exactly 100000000 paise/,
      );
      expect(await commitError(pool, payAs(poor), (c) => relief(c, poor, RELIEF - 1n))).toMatch(/exactly/);
      // the genuine relief for a user below the ceiling commits (control)
      expect(await commitState(pool, payAs(poor), (c) => relief(c, poor, RELIEF))).toBe("no error");
    });

    it("relief is refused while the wallet is at or above the ceiling", async () => {
      expect(await commitError(pool, payAs(buyer), (c) => relief(c, buyer, RELIEF))).toMatch(
        /only for a balance below/,
      );
    });

    it("relief: one per user per UTC day, at most 7 per lifetime", async () => {
      const poor = await poorUser();
      expect(
        await commitState(pool, payAs(poor), async (c) => {
          await relief(c, poor, RELIEF);
          await relief(c, poor, RELIEF);
        }),
      ).toBe("23505");
      // seven earlier reliefs (planted: on past days)
      await plant(pool, async (c) => {
        for (let d = 1; d <= 7; d++) {
          await c.query(
            `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
             VALUES ($1, $2, $3, 'RELIEF', $4, (now() AT TIME ZONE 'UTC')::date - $5::int)`,
            [uuidv7(), poor.userId, uuidv7(), RELIEF.toString(), d],
          );
        }
      });
      expect(await commitError(pool, payAs(poor), (c) => relief(c, poor, RELIEF))).toMatch(
        /at most 7 relief grants/,
      );
    });

    it("relief may not be paid to another user, nor dated another day", async () => {
      const poor = await poorUser();
      expect(await commitError(pool, payAs(buyer), (c) => relief(c, poor, RELIEF))).toMatch(
        /row-level security|acting user/,
      );
      const otherDay = await commitError(pool, payAs(poor), (c) =>
        journal(
          c,
          "RELIEF_GRANT",
          [
            [MINT_ACCOUNT_ID, -RELIEF],
            [poor.ledgerAccountId, RELIEF],
          ],
          (j) =>
            c.query(
              `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
               VALUES ($1, $2, $3, 'RELIEF', $4, '2001-01-01')`,
              [uuidv7(), poor.userId, j, RELIEF.toString()],
            ),
        ),
      );
      expect(otherDay).toMatch(/UTC day must be today/);
    });

    it("a late STARTER_GRANT is refused (only when the account is opened; never for a tombstoned identity)", async () => {
      const poor = await poorUser();
      const starter = (who: ProvisionResult) => (c: pg.PoolClient) =>
        journal(
          c,
          "STARTER_GRANT",
          [
            [MINT_ACCOUNT_ID, -100n * CRORE],
            [who.ledgerAccountId, 100n * CRORE],
          ],
          (j) =>
            c.query(
              "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount) VALUES ($1, $2, $3, 'STARTER', $4)",
              [uuidv7(), who.userId, j, (100n * CRORE).toString()],
            ),
        );
      expect(await commitError(pool, payAs(poor), starter(poor))).toMatch(/only when the account is opened/);
      expect(await commitState(pool, payAs(buyer), starter(buyer))).toBe("23505"); // one_starter
    });

    for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
      it(`only the job runner creates ${type} journals`, async () => {
        const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
        expect(await stateOf(pool, insert, [uuidv7(), type], web(buyer))).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], payAs(buyer))).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], { role: "app_jobs" })).toBe("no error");
      });
    }
  });

  // -------------------------------------------------------------------------------- (2) seller -> self
  describe("attack 2: taking money from a seller", () => {
    it("core.lock_selling_companies no longer exists, and app_web cannot see a seller's ledger account", async () => {
      expect(
        await stateOf(
          pool,
          "SELECT * FROM core.lock_selling_companies(ARRAY[$1]::uuid[])",
          [s.companyId],
          web(buyer),
        ),
      ).toBe("42883");
      expect(
        await asActor(pool, web(buyer), (c) =>
          countRows(c, "SELECT count(*) AS n FROM ledger.ledger_account WHERE id = $1", [
            s.owner.ledgerAccountId,
          ]),
        ),
      ).toBe(0);
    });

    for (const type of ["PURCHASE", "MEMBERSHIP", "COMPANY_REGISTRATION"]) {
      it(`a ${type} journal debiting the seller and crediting the attacker is refused`, async () => {
        const steal = (c: pg.PoolClient) =>
          journal(c, type, [
            [s.owner.ledgerAccountId, -CRORE],
            [buyer.ledgerAccountId, CRORE],
          ]);
        expect(await commitState(pool, web(buyer), steal)).toBe("42501");
        if (type === "PURCHASE") {
          expect(await commitError(pool, payAs(buyer), steal)).toMatch(
            /may debit only the acting user's own account/,
          );
        } else {
          expect(await commitState(pool, payAs(buyer), steal)).toBe("42501"); // unbacked (finding 9)
          expect(await commitError(pool, { userId: buyer.userId }, steal)).toMatch(
            /may debit only the acting user's own account/,
          );
        }
      });
    }

    it("a seller's money cannot be routed through SINK either", async () => {
      const viaSink = (c: pg.PoolClient) =>
        journal(c, "MEMBERSHIP", [
          [s.owner.ledgerAccountId, -CRORE],
          [SINK_ACCOUNT_ID, CRORE],
        ]);
      expect(await commitState(pool, payAs(buyer), viaSink)).toBe("42501"); // unbacked (finding 9)
      expect(await commitError(pool, { userId: buyer.userId }, viaSink)).toMatch(/acting user's own account/);
    });

    it("ledger.sync_wallets cannot be used on arbitrary users' wallets", async () => {
      const bystander = await user(pool);
      const sync = "SELECT ledger.sync_wallets($1)";
      expect(await stateOf(pool, sync, [[bystander.ledgerAccountId]], web(buyer))).toBe("42501");
      expect(await stateOf(pool, sync, [[bystander.ledgerAccountId]], payAs(buyer))).toBe("42501");
      expect(
        await stateOf(pool, sync, [[buyer.ledgerAccountId, s.owner.ledgerAccountId]], payAs(buyer)),
      ).toBe("no error");
    });
  });

  // -------------------------------------------------------------------------------- (3) forged quotes
  describe("attack 3: a forged checkout session is not honoured by pay()", () => {
    /** Inserts a session with a hand-written quote as app_pay, then a BALANCE attempt through the API. */
    async function forgedSession(who: ProvisionResult, quote: unknown, totalPaise: bigint) {
      const sessionId = uuidv7();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.user_id', $1, true)", [who.userId]);
        await c.query("SET LOCAL ROLE app_pay");
        await c.query(
          `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
           VALUES ($1, $2, 'PRODUCT_PURCHASE', $3, $4, 1, now() + interval '5 minutes')`,
          [sessionId, who.userId, JSON.stringify(quote), totalPaise.toString()],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const attempt = await createPaymentAttempt(pool, { userId: who.userId, sessionId, method: "BALANCE" });
      return { sessionId, attemptId: attempt.attemptId };
    }

    const quoteFor = (p: ProductFixture, sellerId: string, opts: Record<string, unknown> = {}) => ({
      version: 1,
      lines: [
        {
          productId: p.id,
          productVersionId: p.versionId,
          sellerId,
          companyId: sellerId === "SEED" ? null : sellerId,
          listPaise: "10000",
          freeStdDelivery: true,
          inventoryMode: sellerId === "SEED" ? "UNLIMITED_SEED" : "STANDARD_STOCKED",
        },
      ],
      speedBySeller: { [sellerId]: "STANDARD" },
      coupon: null,
      isMember: true,
      addressId: null,
      configVersion: 1,
      sellers: [],
      totalPaise: "0",
      ...opts,
    });

    it("app_web cannot insert a checkout session at all", async () => {
      expect(
        await stateOf(
          pool,
          `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
           VALUES ($1, $2, 'PRODUCT_PURCHASE', '{}', 1, 1, now() + interval '5 minutes')`,
          [uuidv7(), buyer.userId],
          web(buyer),
        ),
      ).toBe("42501");
    });

    it("a ₹10 crore item quoted at ₹1,100 through a fake coupon value is refused with CART_CHANGED, nothing debited", async () => {
      const victim = await user(pool);
      const forged = quoteFor(crorePiece, s.companyId, {
        coupon: {
          id: couponId,
          companyId: s.companyId,
          code: "TENOFF",
          kind: "FLAT",
          value: "99999999999",
          minSpendPaise: "0",
        },
      });
      const co = await forgedSession(victim, forged, 1_100n * RUPEE);
      const before = await wallet(pool, victim.ledgerAccountId);
      const outcome = await codeOf(
        pay(pool, {
          userId: victim.userId,
          sessionId: co.sessionId,
          attemptId: co.attemptId,
          idempotencyKey: key(),
        }),
      );
      expect(outcome).toBe("CART_CHANGED");
      expect(await wallet(pool, victim.ledgerAccountId)).toBe(before);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.order_group WHERE session_id = $1", [co.sessionId]),
      ).toBe(0);
    });

    it("a forged list price and free delivery in the quote are ignored: the total is rebuilt from the product rows", async () => {
      const victim = await user(pool);
      const co = await forgedSession(victim, quoteFor(crorePiece, s.companyId), 100n * RUPEE);
      const outcome = await codeOf(
        pay(pool, {
          userId: victim.userId,
          sessionId: co.sessionId,
          attemptId: co.attemptId,
          idempotencyKey: key(),
        }),
      );
      expect(outcome).toBe("CART_CHANGED");
    });

    it("a forged ZAP (or EXPRESS) speed for a product that does not offer it is refused with DELIVERY_UNAVAILABLE", async () => {
      const victim = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 500n * RUPEE });
      for (const speed of ["ZAP", "EXPRESS"] as const) {
        // the total is even "right" for that speed: eligibility, not arithmetic, refuses it
        const co = await forgedSession(
          victim,
          quoteFor(seed, "SEED", { speedBySeller: { SEED: speed } }),
          500n * RUPEE + DELIVERY[speed],
        );
        const outcome = await codeOf(
          pay(pool, {
            userId: victim.userId,
            sessionId: co.sessionId,
            attemptId: co.attemptId,
            idempotencyKey: key(),
          }),
        );
        expect(outcome, speed).toBe("DELIVERY_UNAVAILABLE");
      }
    });

    it("pay re-checks merchant-funded free delivery: withdrawn after the quote → CART_CHANGED", async () => {
      const victim = await user(pool);
      const p = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 2_000n * RUPEE,
        freeStd: true,
      });
      const co = await checkout(pool, victim, [p], standard(s));
      expect(co.totalPaise).toBe(2_000n * RUPEE); // the seller pays delivery
      await pool.query("UPDATE core.product SET free_standard_delivery = false WHERE id = $1", [p.id]);
      expect(await codeOf(payFor(pool, victim, co))).toBe("CART_CHANGED");
    });

    it("pay re-checks the coupon from its locked row: a coupon paused after the quote is refused", async () => {
      const victim = await user(pool);
      const code = `PAUSE${randomBytes(2).toString("hex").toUpperCase()}`;
      const id = await merchantCoupon(pool, s, { code, percent: 20 });
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const co = await checkout(pool, victim, [p], standard(s), code);
      await pool.query("UPDATE core.coupon SET status = 'PAUSED' WHERE id = $1", [id]);
      expect(await codeOf(payFor(pool, victim, co))).toBe("COUPON_INVALID");
    });

    it("Zap from a user company ships only from a Zap hub: quoted and paid from the hub (control)", async () => {
      const victim = await user(pool);
      const hub = uuidv7();
      await pool.query(
        "INSERT INTO core.warehouse (id, company_id, kind, capacity, used, zap_hub) VALUES ($1, $2, 'PURCHASED', 10, 0, true)",
        [hub, s.companyId],
      );
      const inHub = await product(pool, {
        seller: s,
        mode: "EXCLUSIVE",
        pricePaise: 3_000n * RUPEE,
        warehouseId: hub,
      });
      const notInHub = await product(pool, { seller: s, mode: "EXCLUSIVE", pricePaise: 3_000n * RUPEE });
      expect(await codeOf(checkout(pool, victim, [notInHub], { [s.companyId]: "ZAP" }))).toBe(
        "DELIVERY_UNAVAILABLE",
      );
      const co = await checkout(pool, victim, [inHub], { [s.companyId]: "ZAP" });
      expect(co.totalPaise).toBe(3_000n * RUPEE + DELIVERY.ZAP);
      const receipt = await payFor(pool, victim, co);
      expect(
        await count(
          pool,
          `SELECT count(*) AS n FROM core.shipment sh JOIN core.seller_order so ON so.id = sh.seller_order_id
            WHERE so.order_group_id = $1 AND sh.speed = 'ZAP'`,
          [receipt.orderGroupId],
        ),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------- (5) raw purchases
  interface Forge {
    /** One line of this product (default crorePiece), or several lines of `products`, all from `s`. */
    product?: ProductFixture;
    products?: ProductFixture[];
    /** single-line overrides */
    list?: bigint;
    sellerDiscount?: bigint;
    fee?: bigint;
    /** per-line seller discounts (several lines) */
    lineDiscounts?: bigint[];
    speed?: Speed;
    deliveryBuyer?: bigint;
    deliverySeller?: bigint;
    creditAccount?: string;
    /** paid to SINK instead of to the seller (the journal still balances) */
    creditShortfall?: bigint;
    journal?: boolean;
    succeed?: boolean;
    coupon?: { id: string; discount: bigint };
    /** SQL for the session's expires_at */
    sessionExpires?: string;
    buyerSource?: "PLAYER" | "STAFF";
    qualifies?: boolean;
    /** added to the shipment's delivered_at */
    deliveredSkewMs?: number;
    /** runs after the purchase is written, before the caller fires the deferred checks */
    after?: (c: pg.PoolClient) => Promise<unknown>;
  }

  /**
   * A whole purchase written by hand as app_pay, the way pay() writes it. With no options it
   * is a correct purchase of crorePiece (the control); each option tampers with one part.
   */
  async function forgePurchase(c: pg.PoolClient, who: ProvisionResult, o: Forge = {}): Promise<void> {
    const ps = o.products ?? [o.product ?? crorePiece];
    const single = ps.length === 1;
    const lines = ps.map((p, i) => {
      const list = single && o.list !== undefined ? o.list : p.pricePaise;
      const sd = o.lineDiscounts?.[i] ?? (i === 0 ? (o.sellerDiscount ?? 0n) : 0n);
      const fee = single && o.fee !== undefined ? o.fee : ((list - sd) * 5n) / 100n;
      return { p, list, sd, fee, id: uuidv7() };
    });
    const sum = (f: (l: (typeof lines)[number]) => bigint) => lines.reduce((a, l) => a + f(l), 0n);
    const list = sum((l) => l.list);
    const sd = sum((l) => l.sd);
    const fee = sum((l) => l.fee);
    const speed = o.speed ?? "STANDARD";
    const dsel = o.deliverySeller ?? 0n;
    const db = o.deliveryBuyer ?? (dsel > 0n ? 0n : DELIVERY[speed]);
    const net = list - sd - fee - dsel;
    const total = list - sd + db;
    const shortfall = o.creditShortfall ?? 0n;
    const [session, attempt, journalId, group, so] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    // a real session names its coupon in the quote (pay() and app_pay's coupon policy read it)
    const quote = o.coupon ? { coupon: { id: o.coupon.id } } : {};
    await c.query(
      `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
       VALUES ($1, $2, 'PRODUCT_PURCHASE', $3, $4, 1, ${o.sessionExpires ?? "now() + interval '5 minutes'"})`,
      [session, who.userId, JSON.stringify(quote), total.toString()],
    );
    await c.query(
      "INSERT INTO core.payment_attempt (id, session_id, user_id, method, reference) VALUES ($1, $2, $3, 'BALANCE', $4)",
      [attempt, session, who.userId, `F-${attempt}`],
    );
    if (o.journal !== false) {
      await c.query(
        "INSERT INTO ledger.journal (id, event_type, config_version, order_group_id) VALUES ($1, 'PURCHASE', 1, $2)",
        [journalId, group],
      );
      const credit = o.creditAccount ?? s.owner.ledgerAccountId;
      await c.query(
        `INSERT INTO ledger.posting (journal_id, account_id, amount, seller_order_id, memo) VALUES
           ($1, $2, $3, NULL, 'Purchase'), ($1, $4, $5, $6, 'Sale proceeds'), ($1, $7, $8, NULL, 'Fees')`,
        [
          journalId,
          who.ledgerAccountId,
          (-total).toString(),
          credit,
          (net - shortfall).toString(),
          so,
          SINK_ACCOUNT_ID,
          (fee + db + dsel + shortfall).toString(),
        ],
      );
      await c.query("SELECT ledger.sync_wallets($1)", [[who.ledgerAccountId, credit]]);
    }
    await c.query(
      `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [group, who.userId, session, attempt, journalId, o.buyerSource ?? "PLAYER", total.toString()],
    );
    await c.query(
      `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise,
         seller_discount_paise, fee_paise, delivery_fee_buyer_paise, delivery_fee_seller_paise, net_paise,
         qualifies_for_progression)
       VALUES ($1, $2, $3, $4, 'USER', $5, $6, $7, $8, $9, $10, $11)`,
      [
        so,
        group,
        who.userId,
        s.companyId,
        list.toString(),
        sd.toString(),
        fee.toString(),
        db.toString(),
        dsel.toString(),
        net.toString(),
        o.qualifies ?? true,
      ],
    );
    for (const [i, l] of lines.entries()) {
      const unit = await c.query<{ id: string; warehouse_id: string }>(
        `SELECT id, warehouse_id FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE'
          ORDER BY serial LIMIT 1 FOR UPDATE`,
        [l.p.id],
      );
      const u = unit.rows[0];
      if (!u) throw new Error("fixture: no unit left");
      await c.query(
        `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
           seller_discount_paise, platform_discount_paise, fee_paise, inventory_unit_id, line_no)
         VALUES ($1, $2, $3, $4, '{}', $5, $6, 0, $7, $8, $9)`,
        [l.id, so, l.p.id, l.p.versionId, l.list.toString(), l.sd.toString(), l.fee.toString(), u.id, i],
      );
      await c.query(
        "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
        [uuidv7(), who.userId, l.p.id, l.id],
      );
      await c.query("UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = $2 WHERE id = $1", [
        u.id,
        l.id,
      ]);
      await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [l.p.id]);
      await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [u.warehouse_id]);
    }
    if (o.coupon) {
      await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [o.coupon.id]);
      await c.query(
        "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, $4)",
        [o.coupon.id, who.userId, group, o.coupon.discount.toString()],
      );
    }
    // the schedule pay() writes: placed at the journal's time, then 10/30/70/100% of the duration
    const d = DEFAULT_DELIVERY_DURATIONS_MS[speed];
    const at = (pct: number) => Math.floor((d * pct) / 100);
    await c.query(
      `INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at)
       SELECT $1, $2, $3, t, t + $4 * interval '1 millisecond', t + $5 * interval '1 millisecond',
              t + $6 * interval '1 millisecond', t + $7 * interval '1 millisecond'
         FROM (SELECT COALESCE((SELECT created_at FROM ledger.journal WHERE id = $8), clock_timestamp()) AS t) x`,
      [uuidv7(), so, speed, at(10), at(30), at(70), d + (o.deliveredSkewMs ?? 0), journalId],
    );
    if (o.succeed !== false) {
      await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [attempt]);
      await c.query("UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = $1", [session]);
    }
    await o.after?.(c);
  }

  describe("attack 5: a purchase written by hand with raw SQL", () => {
    it("control: a correct hand-written purchase passes every structural rule (so each refusal below is the tampering)", async () => {
      expect(await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer))).toBe("no error");
    });

    it("refused at commit: a purchase while purchases are switched off", async () => {
      await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'purchases'");
      try {
        expect(await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer))).toMatch(/switched off/);
      } finally {
        await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'purchases'");
      }
    });

    const tampering: [string, Forge, RegExp][] = [
      [
        "₹10 crore item booked at ₹100 (₹1,100 with delivery)",
        { list: 100n * RUPEE },
        /not the current price/,
      ],
      [
        "seller discount with no coupon",
        { sellerDiscount: 10n * CRORE - 100n * RUPEE },
        /seller discount needs a coupon/,
      ],
      ["no marketplace fee", { fee: 0n }, /discount or fee/],
      ["delivery fee skipped", { deliveryBuyer: 0n }, /delivery fees do not follow/],
      ["ZAP for a product with no unit in a Zap hub", { speed: "ZAP" }, /ZAP delivery is not offered/],
      [
        "EXPRESS for a product that does not offer it",
        { speed: "EXPRESS" },
        /EXPRESS delivery is not offered/,
      ],
      [
        "seller proceeds diverted to an accomplice",
        { creditAccount: "ACCOMPLICE" },
        /USER credit is not a seller order's proceeds/,
      ],
      ["no journal at all", { journal: false }, /PURCHASE journal|foreign key/],
      ["attempt and session never succeeded", { succeed: false }, /SUCCEEDED/],
    ];
    for (const [label, forge, why] of tampering) {
      it(`refused at commit: ${label}`, async () => {
        const o =
          forge.creditAccount === "ACCOMPLICE"
            ? { ...forge, creditAccount: accomplice.ledgerAccountId }
            : forge;
        expect(await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, o))).toMatch(why);
      });
    }

    it("refused at commit: a genuine coupon redeemed for more than it gives", async () => {
      const message = await commitError(pool, payAs(buyer), (c) =>
        forgePurchase(c, buyer, {
          sellerDiscount: 10n * CRORE - 100n * RUPEE,
          coupon: { id: couponId, discount: 10n * CRORE - 100n * RUPEE },
        }),
      );
      expect(message).toMatch(/not what coupon/);
      // the same coupon applied as it really applies (10%) passes
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, { sellerDiscount: CRORE, coupon: { id: couponId, discount: CRORE } }),
        ),
      ).toBe("no error");
    });

    describe("direct inserts and state changes", () => {
      let paid: {
        groupId: string;
        sellerOrderId: string;
        lineId: string;
        attemptId: string;
        sessionId: string;
      };

      beforeAll(async () => {
        const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 1_000n * RUPEE });
        const co = await checkout(pool, buyer, [p], standard(s));
        const receipt = await payFor(pool, buyer, co);
        const { rows } = await pool.query<{ so: string; line: string }>(
          `SELECT so.id AS so, l.id AS line FROM core.seller_order so JOIN core.order_line l ON l.seller_order_id = so.id
            WHERE so.order_group_id = $1`,
          [receipt.orderGroupId],
        );
        paid = {
          groupId: receipt.orderGroupId,
          sellerOrderId: rows[0]?.so ?? "",
          lineId: rows[0]?.line ?? "",
          attemptId: co.attemptId,
          sessionId: co.sessionId,
        };
      });

      const both = async (fn: (c: pg.PoolClient) => Promise<unknown>) => ({
        web: await commitState(pool, web(buyer), fn),
        pay: await commitError(pool, payAs(buyer), fn),
      });

      it("order_group alone, pointing at an existing journal, attempt and session", async () => {
        const r = await both((c) =>
          c.query(
            `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
             SELECT $1, buyer_user_id, $2, $3, journal_id, 'PLAYER', 1, 1 FROM core.order_group WHERE id = $4`,
            [uuidv7(), uuidv7(), uuidv7(), paid.groupId],
          ),
        );
        expect(r.web).toBe("42501");
        expect(r.pay).not.toBe("no error");
      });

      it("seller_order added to an earlier order group", async () => {
        const r = await both((c) =>
          c.query(
            `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise)
             VALUES ($1, $2, $3, NULL, 'SEED', 10000, 0, 10000)`,
            [uuidv7(), paid.groupId, buyer.userId],
          ),
        );
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/created in this transaction/) });
      });

      it("order_line added to an earlier seller order", async () => {
        const r = await both((c) =>
          c.query(
            `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
               seller_discount_paise, platform_discount_paise, fee_paise)
             VALUES ($1, $2, $3, $4, '{}', 10000, 0, 0, 0)`,
            [uuidv7(), paid.sellerOrderId, crorePiece.id, crorePiece.versionId],
          ),
        );
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/created in this transaction/) });
      });

      it("ownership of a ₹10 crore item on an earlier, cheap order line", async () => {
        const r = await both((c) =>
          c.query(
            "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
            [uuidv7(), buyer.userId, crorePiece.id, paid.lineId],
          ),
        );
        expect(r.web).toBe("42501");
        expect(r.pay).not.toBe("no error");
      });

      it("shipment for a seller order that does not exist", async () => {
        const r = await both((c) =>
          c.query(
            `INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at)
             VALUES ($1, $2, 'ZAP', now(), now(), now(), now(), now())`,
            [uuidv7(), uuidv7()],
          ),
        );
        expect(r.web).toBe("42501");
        expect(r.pay).not.toBe("no error");
      });

      it("coupon_redemption on an earlier order group (burning a merchant's coupon cap)", async () => {
        const capped = await merchantCoupon(pool, s, {
          code: `CAP${randomBytes(2).toString("hex")}`,
          percent: 5,
          maxRedemptions: 1,
        });
        const r = await both(async (c) => {
          // the attacker names the coupon in a session of their own so app_pay may touch it
          await nameCoupon(c, buyer, capped);
          await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [capped]);
          await c.query(
            "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, 0)",
            [capped, buyer.userId, paid.groupId],
          );
        });
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/created in this transaction/) });
      });

      it("marking an attempt or a session SUCCEEDED without an order", async () => {
        const co = await checkout(
          pool,
          buyer,
          [await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE })],
          standard("SEED"),
        );
        for (const [table, id] of [
          ["payment_attempt", co.attemptId],
          ["checkout_session", co.sessionId],
        ] as const) {
          const r = await both((c) =>
            c.query(`UPDATE core.${table} SET state = 'SUCCEEDED' WHERE id = $1`, [id]),
          );
          expect(r, table).toEqual({
            web: "42501",
            pay: expect.stringMatching(/SUCCEEDED without an order group/),
          });
        }
      });

      it("states only move forward: FAILED -> SUCCEEDED, SUCCEEDED -> OPEN are refused", async () => {
        const co = await checkout(
          pool,
          buyer,
          [await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE })],
          standard("SEED"),
        );
        const back = await commitError(pool, payAs(buyer), async (c) => {
          await c.query("UPDATE core.payment_attempt SET state = 'FAILED' WHERE id = $1", [co.attemptId]);
          await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [co.attemptId]);
        });
        expect(back).toMatch(/final/);
        expect(
          await commitError(pool, payAs(buyer), (c) =>
            c.query("UPDATE core.checkout_session SET state = 'OPEN' WHERE id = $1", [paid.sessionId]),
          ),
        ).toMatch(/may move only OPEN/);
      });
    });
  });

  // -------------------------------------------------------------------------------- (6) card attempts
  describe("attack 6: card attempts", () => {
    async function openSession(who: ProvisionResult): Promise<string> {
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const session = await createCheckoutSession(pool, {
        userId: who.userId,
        lines: [{ productId: p.id }],
        speedBySeller: standard("SEED"),
        idempotencyKey: key(),
      });
      return session.sessionId;
    }

    it("a CARD attempt inserted already authenticated is refused", async () => {
      const sessionId = await openSession(buyer);
      const insert = (c: pg.PoolClient) =>
        c.query(
          `INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference, authenticated_at)
           VALUES ($1, $2, $3, 'CARD', $4, $5, now())`,
          [uuidv7(), sessionId, buyer.userId, buyer.cardId, `R-${uuidv7()}`],
        );
      expect(await commitState(pool, web(buyer), insert)).toBe("42501");
      expect(await commitError(pool, payAs(buyer), insert)).toMatch(/authentication is a separate step/);
    });

    it("authentication is stamped by the database clock, once", async () => {
      const sessionId = await openSession(buyer);
      const attempt = await createPaymentAttempt(pool, {
        userId: buyer.userId,
        sessionId,
        method: "CARD",
        cardId: buyer.cardId,
      });
      await markAttemptAuthenticated(pool, { userId: buyer.userId, attemptId: attempt.attemptId });
      const { rows } = await pool.query<{ recent: boolean }>(
        "SELECT authenticated_at > now() - interval '1 minute' AS recent FROM core.payment_attempt WHERE id = $1",
        [attempt.attemptId],
      );
      expect(rows[0]?.recent).toBe(true);
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          c.query("UPDATE core.payment_attempt SET authenticated_at = '2001-01-01' WHERE id = $1", [
            attempt.attemptId,
          ]),
        ),
      ).toMatch(/authenticated, once/);
    });

    it("an attempt on another user's card is refused by the database, and by pay()", async () => {
      const other = await user(pool);
      const sessionId = await openSession(buyer);
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          c.query(
            "INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference) VALUES ($1, $2, $3, 'CARD', $4, $5)",
            [uuidv7(), sessionId, buyer.userId, other.cardId, `R-${uuidv7()}`],
          ),
        ),
      ).toMatch(/does not belong to the paying user/);
      // pay() refuses such an attempt even if one exists (planted: the database would not accept it)
      const attemptId = uuidv7();
      await plant(pool, (c) =>
        c.query(
          `INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference, authenticated_at)
           VALUES ($1, $2, $3, 'CARD', $4, $5, now())`,
          [attemptId, sessionId, buyer.userId, other.cardId, `R-${attemptId}`],
        ),
      );
      const before = await wallet(pool, buyer.ledgerAccountId);
      expect(
        await codeOf(pay(pool, { userId: buyer.userId, sessionId, attemptId, idempotencyKey: key() })),
      ).toBe("CARD_NOT_OWNED");
      expect(await wallet(pool, buyer.ledgerAccountId)).toBe(before);
    });
  });

  // -------------------------------------------------------------------------------- (5) counters and units
  describe("attack 5: editing stock and coupon counters, issuing units", () => {
    const edits: [string, string, () => unknown[], RegExp, ((c: pg.PoolClient) => Promise<unknown>)?][] = [
      [
        "product.available_units",
        "UPDATE core.product SET available_units = available_units + 5 WHERE id = $1",
        () => [crorePiece.id],
        /available_units must equal/,
      ],
      [
        "coupon.redeemed",
        "UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1",
        () => [couponId],
        /redeemed must equal/,
        // a private coupon is visible to app_pay only once named in the buyer's own session
        (c) => nameCoupon(c, buyer, couponId),
      ],
      [
        "warehouse.used",
        "UPDATE core.warehouse SET used = used + 1 WHERE id = $1",
        () => [s.warehouseId],
        /used must equal/,
      ],
    ];
    for (const [label, sql, params, why, setup] of edits) {
      it(`${label}: no privilege for app_web, inconsistent for app_pay`, async () => {
        expect(await commitState(pool, web(buyer), (c) => c.query(sql, params()))).toBe("42501");
        expect(
          await commitError(pool, payAs(buyer), async (c) => {
            await setup?.(c);
            return c.query(sql, params());
          }),
        ).toMatch(why);
      });
    }

    it("a unit cannot be marked ISSUED without an order line of this transaction, nor put back on sale", async () => {
      // the attacker keeps the counters consistent, so it is the issue rule that refuses it
      const issue = async (c: pg.PoolClient) => {
        await c.query(
          `UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = $2
            WHERE id = (SELECT id FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE' LIMIT 1)`,
          [crorePiece.id, uuidv7()],
        );
        await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [
          crorePiece.id,
        ]);
        await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [s.warehouseId]);
      };
      expect(await commitState(pool, web(buyer), issue)).toBe("42501");
      expect(await commitError(pool, payAs(buyer), issue)).toMatch(/may become ISSUED only/);
      const restocked = await asActor(
        pool,
        payAs(buyer),
        async (c) =>
          (
            await c.query(
              "UPDATE core.inventory_unit SET state = 'AVAILABLE', order_line_id = NULL WHERE state = 'ISSUED'",
            )
          ).rowCount,
      );
      expect(restocked).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------- (4) seller locks
  describe("attack 4: blocking a seller by holding its company lock", () => {
    async function holdThenProbe(as: Actor, lock: string): Promise<{ held: number; probe: string }> {
      const holder = await pool.connect();
      const prober = new pg.Client({ connectionString: db.url });
      await prober.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT set_config('app.user_id', $1, true)", [as.userId ?? ""]);
        if (as.role) await holder.query(`SET LOCAL ROLE ${as.role}`);
        const held =
          (await holder.query(`SELECT id FROM core.company WHERE id = $1 ${lock}`, [s.companyId])).rowCount ??
          0;
        const probe = await sqlState(
          prober.query("SELECT id FROM core.company WHERE id = $1 FOR UPDATE NOWAIT", [s.companyId]),
        );
        return { held, probe };
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await prober.end();
      }
    }

    for (const lock of ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"]) {
      it(`app_web cannot take a ${lock} lock on another seller's company`, async () => {
        expect(await holdThenProbe(web(buyer), lock)).toEqual({ held: 0, probe: "no error" });
      });
    }

    it("app_pay can (pay needs it) but cannot change the company", async () => {
      expect(await holdThenProbe(payAs(buyer), "FOR UPDATE")).toEqual({ held: 1, probe: "55P03" });
      expect(
        await stateOf(
          pool,
          "UPDATE core.company SET name = 'mine' WHERE id = $1",
          [s.companyId],
          payAs(buyer),
        ),
      ).toBe("42501");
    });

    it("app_web cannot lock a seller's wallet either", async () => {
      expect(
        await stateOf(
          pool,
          "SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE",
          [s.owner.ledgerAccountId],
          web(buyer),
        ),
      ).toBe("42501");
    });
  });

  // -------------------------------------------------------------------------------- reviewer's missing tests
  describe("creator entitlement", () => {
    const insertEntitlement = (who: ProvisionResult, groupId: string) => (c: pg.PoolClient) =>
      c.query(
        "INSERT INTO core.creator_entitlement (id, user_id, source, evidence_order_group_id) VALUES ($1, $2, 'PURCHASE_THRESHOLD', $3)",
        [uuidv7(), who.userId, groupId],
      );

    it("cannot be inserted without a genuine own order of this transaction and a wallet below the threshold", async () => {
      // a rich buyer with a real order
      const rich = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const richOrder = await payFor(pool, rich, await checkout(pool, rich, [seed], standard("SEED")));
      expect(await commitState(pool, web(rich), insertEntitlement(rich, richOrder.orderGroupId))).toBe(
        "42501",
      );
      expect(await commitState(pool, payAs(rich), insertEntitlement(rich, richOrder.orderGroupId))).toBe(
        "42501",
      );
      // someone else's order as evidence
      expect(await commitState(pool, payAs(buyer), insertEntitlement(buyer, richOrder.orderGroupId))).toBe(
        "42501",
      );

      // a buyer below the threshold whose unlock was revoked: an earlier order is not evidence
      const spender = await user(pool);
      const big = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 989_999_001n * RUPEE });
      const spent = await payFor(pool, spender, await checkout(pool, spender, [big], standard("SEED")));
      expect(spent.creatorUnlocked).toBe(true);
      await pool.query("DELETE FROM core.creator_entitlement WHERE user_id = $1", [spender.userId]);
      expect(await commitError(pool, payAs(spender), insertEntitlement(spender, spent.orderGroupId))).toMatch(
        /created in this transaction/,
      );
    });

    it("a second unlock is not created", async () => {
      const spender = await user(pool);
      const big = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 989_999_001n * RUPEE });
      const first = await payFor(pool, spender, await checkout(pool, spender, [big], standard("SEED")));
      expect(first.creatorUnlocked).toBe(true);
      const small = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const second = await payFor(pool, spender, await checkout(pool, spender, [small], standard("SEED")));
      expect(second.creatorUnlocked).toBe(false);
      expect(
        await commitState(pool, payAs(spender), insertEntitlement(spender, second.orderGroupId)),
      ).not.toBe("no error");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.creator_entitlement WHERE user_id = $1", [
          spender.userId,
        ]),
      ).toBe(1);
    });
  });

  // ================================================================================ second review
  /** Runs fn at the given isolation level as the actor, fires the deferred checks, rolls back. */
  async function atIsolation(
    level: "REPEATABLE READ" | "SERIALIZABLE" | "READ COMMITTED",
    as: Actor,
    fn: (c: pg.PoolClient) => Promise<unknown>,
  ): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      await c.query("SELECT set_config('app.user_id', $1, true)", [as.userId ?? ""]);
      if (as.role) await c.query(`SET LOCAL ROLE ${as.role}`);
      await fn(c);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      return "no error";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  /** Runs fn as app_web for `who`, with app.company_id set to `company` (a setting the caller controls). */
  const claiming = <T>(who: ProvisionResult, company: string, fn: (c: pg.PoolClient) => Promise<T>) =>
    asActor(pool, web(who), async (c) => {
      await c.query("SELECT set_config('app.company_id', $1, true)", [company]);
      return fn(c);
    });

  describe("review 2, finding 1: company scope comes from the acting user, never from app.company_id", () => {
    it("naming a victim's company gives no write: no coupon on it, and its product cannot be hidden", async () => {
      const hugeFlat = (c: pg.PoolClient) =>
        c.query(
          `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value, is_public)
           VALUES ($1, 'MERCHANT', $2, 'FREEBIE', 'FLAT', 99999999999, true)`,
          [uuidv7(), s.companyId],
        );
      expect(await claiming(buyer, s.companyId, (c) => sqlState(hugeFlat(c)))).toBe("42501");
      const hidden = await claiming(
        buyer,
        s.companyId,
        async (c) =>
          (await c.query("UPDATE core.product SET status = 'ARCHIVED' WHERE id = $1", [crorePiece.id]))
            .rowCount,
      );
      expect(hidden).toBe(0);
    });

    it("naming a victim's company gives no read of its private coupons, drafts or seller orders", async () => {
      const sold = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 300n * RUPEE });
      await payFor(pool, buyer, await checkout(pool, buyer, [sold], standard(s)));
      const draft = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 300n * RUPEE });
      await pool.query("UPDATE core.product SET status = 'DRAFT' WHERE id = $1", [draft.id]);
      const look = async (c: pg.PoolClient) => ({
        privateCoupon: await countRows(c, "SELECT count(*) AS n FROM core.coupon WHERE id = $1", [couponId]),
        draft: await countRows(c, "SELECT count(*) AS n FROM core.product WHERE id = $1", [draft.id]),
        draftVersion: await countRows(c, "SELECT count(*) AS n FROM core.product_version WHERE id = $1", [
          draft.versionId,
        ]),
        sellerOrders: await countRows(
          c,
          "SELECT count(*) AS n FROM core.seller_order WHERE company_id = $1",
          [s.companyId],
        ),
      });
      expect(await claiming(accomplice, s.companyId, look)).toEqual({
        privateCoupon: 0,
        draft: 0,
        draftVersion: 0,
        sellerOrders: 0,
      });
      // the owner, derived from app.user_id alone, sees all of it (control)
      const owner = await asActor(pool, web(s.owner), look);
      expect(owner).toMatchObject({ privateCoupon: 1, draft: 1, draftVersion: 1 });
      expect(owner.sellerOrders).toBeGreaterThan(0);
    });

    it("the owner creates coupons and draft products on their own company only", async () => {
      const coupon = (company: string) =>
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value)
         VALUES ('${uuidv7()}', 'MERCHANT', '${company}', 'OWN5', 'PERCENT', 5)`;
      expect(await stateOf(pool, coupon(s.companyId), [], web(s.owner))).toBe("no error");
      const other = await seller(pool);
      expect(await stateOf(pool, coupon(other.companyId), [], web(s.owner))).toBe("42501");
      const draft = (company: string) =>
        `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode)
         VALUES ('${uuidv7()}', '${company}', 'USER', 'DRAFT', 'gadgets', 'STANDARD_STOCKED')`;
      expect(await stateOf(pool, draft(s.companyId), [], web(s.owner))).toBe("no error");
      expect(await stateOf(pool, draft(other.companyId), [], web(s.owner))).toBe("42501");
    });

    it("no policy or database function reads app.company_id, and the transaction API has no company option", async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM pg_policies
                  WHERE COALESCE(qual, '') || COALESCE(with_check, '') ~ 'app_company_id|app\\.company_id')
              + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname IN ('core', 'ledger', 'private', 'audit', 'analytics', 'sandbox')
                    AND (p.proname = 'app_company_id' OR p.prosrc ~ 'app\\.company_id')) AS n`,
      );
      expect(rows[0]?.n).toBe("0");
      // @ts-expect-error companyId was removed: company scope is derived in the database
      const options: TransactionOptions = { companyId: s.companyId };
      expect(options).toBeDefined();
    });
  });

  describe("review 2, finding 2: private coupon codes are not listable", () => {
    let publicId: string;
    beforeAll(async () => {
      publicId = uuidv7();
      await pool.query(
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value, is_public)
         VALUES ($1, 'MERCHANT', $2, 'EVERYONE5', 'PERCENT', 5, true)`,
        [publicId, s.companyId],
      );
    });
    const visible = (c: pg.PoolClient) =>
      countRows(c, "SELECT count(*) AS n FROM core.coupon WHERE id = ANY($1)", [[couponId]]).then(
        async (priv) => ({
          private: priv,
          public: await countRows(c, "SELECT count(*) AS n FROM core.coupon WHERE id = $1", [publicId]),
        }),
      );

    it("app_web: a private coupon is readable only by its company's owner; public ACTIVE ones by everyone", async () => {
      expect(await asActor(pool, web(accomplice), visible)).toEqual({ private: 0, public: 1 });
      expect(await asActor(pool, web(s.owner), visible)).toEqual({ private: 1, public: 1 });
    });

    it("app_pay cannot list private coupons; it finds one only by its exact code, and app_web cannot look codes up", async () => {
      expect(await asActor(pool, payAs(accomplice), visible)).toEqual({ private: 0, public: 1 });
      const find = "SELECT count(*) AS n FROM core.find_coupon($1, $2::uuid[]) WHERE id = $3";
      expect(
        await asActor(pool, payAs(accomplice), (c) =>
          countRows(c, find, ["TENOFF", [s.companyId], couponId]),
        ),
      ).toBe(1);
      expect(
        await asActor(pool, payAs(accomplice), (c) => countRows(c, find, ["TENOF", [s.companyId], couponId])),
      ).toBe(0);
      expect(
        await stateOf(
          pool,
          "SELECT * FROM core.find_coupon('TENOFF', $1::uuid[])",
          [[s.companyId]],
          web(buyer),
        ),
      ).toBe("42501");
      // the buyer who types the code still gets it (control): quoted with the 10% discount
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const co = await checkout(pool, accomplice, [p], standard(s), "tenoff");
      expect(co.totalPaise).toBe(1_800n * RUPEE + DELIVERY.STANDARD);
    });
  });

  /** A hand-written purchase of one unlimited seed product (as pay() writes it), as app_pay. */
  async function forgeSeedPurchase(c: pg.PoolClient, who: ProvisionResult, p: ProductFixture): Promise<void> {
    const total = p.pricePaise + DELIVERY.STANDARD;
    const [session, attempt, journalId, group, so, line] = [
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
    ];
    await c.query(
      `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
       VALUES ($1, $2, 'PRODUCT_PURCHASE', '{}', $3, 1, now() + interval '5 minutes')`,
      [session, who.userId, total.toString()],
    );
    await c.query(
      "INSERT INTO core.payment_attempt (id, session_id, user_id, method, reference) VALUES ($1, $2, $3, 'BALANCE', $4)",
      [attempt, session, who.userId, `F-${attempt}`],
    );
    await c.query(
      "INSERT INTO ledger.journal (id, event_type, config_version, order_group_id) VALUES ($1, 'PURCHASE', 1, $2)",
      [journalId, group],
    );
    await c.query(
      `INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'Purchase'), ($1, $4, $5, 'Seed')`,
      [journalId, who.ledgerAccountId, (-total).toString(), SINK_ACCOUNT_ID, total.toString()],
    );
    await c.query("SELECT ledger.sync_wallets($1)", [[who.ledgerAccountId]]);
    await c.query(
      `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
       VALUES ($1, $2, $3, $4, $5, 'PLAYER', $6, 1)`,
      [group, who.userId, session, attempt, journalId, total.toString()],
    );
    await c.query(
      `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise,
         fee_paise, delivery_fee_buyer_paise, net_paise)
       VALUES ($1, $2, $3, NULL, 'SEED', $4, 0, $5, $4)`,
      [so, group, who.userId, p.pricePaise.toString(), DELIVERY.STANDARD.toString()],
    );
    await c.query(
      `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
         seller_discount_paise, platform_discount_paise, fee_paise)
       VALUES ($1, $2, $3, $4, '{}', $5, 0, 0, 0)`,
      [line, so, p.id, p.versionId, p.pricePaise.toString()],
    );
    await c.query(
      "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
      [uuidv7(), who.userId, p.id, line],
    );
    const d = DEFAULT_DELIVERY_DURATIONS_MS.STANDARD;
    await c.query(
      `INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at)
       SELECT $1, $2, 'STANDARD', t, t + $3 * interval '1 millisecond', t + $4 * interval '1 millisecond',
              t + $5 * interval '1 millisecond', t + $6 * interval '1 millisecond'
         FROM (SELECT created_at AS t FROM ledger.journal WHERE id = $7) x`,
      [uuidv7(), so, d / 10, (d * 3) / 10, (d * 7) / 10, d, journalId],
    );
    await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [attempt]);
    await c.query("UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = $1", [session]);
  }

  describe("review 2, finding 3: money checks run only at READ COMMITTED and read fresh, locked rows", () => {
    it("a hand-written purchase committed at REPEATABLE READ with the purchases switch turned off since its snapshot is refused", async () => {
      const outcome = await atIsolation("REPEATABLE READ", payAs(buyer), async (c) => {
        await c.query("SELECT 1"); // the snapshot is taken: the switch is on
        await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'purchases'");
        try {
          await forgePurchase(c, buyer);
          await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        } finally {
          await pool.query("UPDATE core.system_switch SET enabled = true WHERE name = 'purchases'");
        }
      });
      expect(outcome).toMatch(/READ COMMITTED/);
    });

    it("every isolation level but READ COMMITTED is refused, for purchases and for the wallet and journal checks", async () => {
      const reversal = (c: pg.PoolClient) =>
        journal(c, "REVERSAL", [
          [buyer.ledgerAccountId, -RUPEE],
          [SINK_ACCOUNT_ID, RUPEE],
        ]);
      for (const level of ["REPEATABLE READ", "SERIALIZABLE"] as const) {
        expect(await atIsolation(level, payAs(buyer), (c) => forgePurchase(c, buyer)), level).toMatch(
          /READ COMMITTED/,
        );
        expect(await atIsolation(level, { role: "app_jobs" }, reversal), level).toMatch(/READ COMMITTED/);
      }
      // the same writes at READ COMMITTED commit (control)
      expect(await atIsolation("READ COMMITTED", payAs(buyer), (c) => forgePurchase(c, buyer))).toBe(
        "no error",
      );
      expect(await atIsolation("READ COMMITTED", { role: "app_jobs" }, reversal)).toBe("no error");
    });

    it("an unlimited-seed product repriced while a hand-written purchase is open: refused at commit (fresh read)", async () => {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 50n * CRORE });
      const outcome = await commitError(pool, payAs(accomplice), async (c) => {
        await forgeSeedPurchase(c, accomplice, seed);
        await reprice(pool, seed, 60n * CRORE); // commits on another connection
      });
      expect(outcome).toMatch(/not the current price/);
    });

    it("the commit-time check holds the sold unlimited-seed product FOR SHARE until commit", async () => {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 400n * RUPEE });
      const c = await pool.connect();
      const prober = new pg.Client({ connectionString: db.url });
      await prober.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.user_id', $1, true)", [accomplice.userId]);
        await c.query("SET LOCAL ROLE app_pay");
        await forgeSeedPurchase(c, accomplice, seed);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE"); // the checks run (and pass) now
        expect(
          await sqlState(
            prober.query("SELECT 1 FROM core.product WHERE id = $1 FOR UPDATE NOWAIT", [seed.id]),
          ),
        ).toBe("55P03");
      } finally {
        await c.query("ROLLBACK");
        c.release();
        await prober.end();
      }
    });

    it("pay() locks every product it sells, unlimited seed stock included", async () => {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 400n * RUPEE });
      const co = await checkout(pool, accomplice, [seed], standard("SEED"));
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM core.product WHERE id = $1 FOR UPDATE", [seed.id]);
        expect(await codeOf(payFor(pool, accomplice, co))).toBe("BUSY");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
  });

  describe("review 2, finding 4: dates come from the database clock", () => {
    it("journal.created_at is stamped at insert: a supplied date is ignored", async () => {
      const recent = await asActor(pool, { role: "app_jobs" }, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version, created_at) VALUES ($1, 'REVERSAL', 1, '2001-01-01')",
          [j],
        );
        const { rows } = await c.query<{ recent: boolean }>(
          "SELECT created_at > clock_timestamp() - interval '1 minute' AS recent FROM ledger.journal WHERE id = $1",
          [j],
        );
        return rows[0]?.recent;
      });
      expect(recent).toBe(true);
    });

    it("a second relief in the same real day cannot be dated on another day", async () => {
      const poor = await poorUser();
      await withTransaction(pool, (c) => relief(c, poor, RELIEF), { role: "app_pay", userId: poor.userId });
      // spend a little so the wallet is below the relief ceiling again
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      await payFor(pool, poor, await checkout(pool, poor, [seed], standard("SEED")));
      expect(await wallet(pool, poor.ledgerAccountId)).toBeLessThan(RELIEF);
      const backdated = await commitError(pool, payAs(poor), async (c) => {
        const j = uuidv7();
        await c.query(
          `INSERT INTO ledger.journal (id, event_type, config_version, created_at)
           VALUES ($1, 'RELIEF_GRANT', 1, now() - interval '1 day')`,
          [j],
        );
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x'), ($1, $4, $5, 'x')",
          [j, MINT_ACCOUNT_ID, (-RELIEF).toString(), poor.ledgerAccountId, RELIEF.toString()],
        );
        await c.query(
          `INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day)
           VALUES ($1, $2, $3, 'RELIEF', $4, ((now() - interval '1 day') AT TIME ZONE 'UTC')::date)`,
          [uuidv7(), poor.userId, j, RELIEF.toString()],
        );
        await c.query("SELECT ledger.sync_wallets($1)", [[poor.ledgerAccountId]]);
      });
      expect(backdated).toMatch(/UTC day must be today/);
    });

    it("a checkout session that expires while the purchase transaction is open is refused at commit", async () => {
      const outcome = await commitError(pool, payAs(buyer), (c) =>
        forgePurchase(c, buyer, {
          sessionExpires: "clock_timestamp() + interval '1 second'",
          after: (x) => x.query("SELECT pg_sleep(1.3)"),
        }),
      );
      expect(outcome).toMatch(/unexpired PRODUCT_PURCHASE session/);
    });

    it("a coupon whose window ends while the purchase transaction is open is refused at commit", async () => {
      const id = uuidv7();
      await pool.query(
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value, ends_at)
         VALUES ($1, 'MERCHANT', $2, $3, 'PERCENT', 10, clock_timestamp() + interval '1.5 seconds')`,
        [id, s.companyId, `SOON${randomBytes(2).toString("hex").toUpperCase()}`],
      );
      const outcome = await commitError(pool, payAs(buyer), (c) =>
        forgePurchase(c, buyer, {
          sellerDiscount: CRORE,
          coupon: { id, discount: CRORE },
          after: (x) => x.query("SELECT pg_sleep(1.8)"),
        }),
      );
      expect(outcome).toMatch(/not a valid merchant coupon/);
    });

    it("a membership that ends while the purchase transaction is open no longer waives delivery at commit", async () => {
      const member = await user(pool);
      await pool.query(
        `INSERT INTO core.membership (id, user_id, starts_at, ends_at, journal_id)
         VALUES ($1, $2, now() - interval '1 hour', clock_timestamp() + interval '1.5 seconds', $3)`,
        [uuidv7(), member.userId, uuidv7()],
      );
      const outcome = await commitError(pool, payAs(member), (c) =>
        forgePurchase(c, member, { deliveryBuyer: 0n, after: (x) => x.query("SELECT pg_sleep(1.8)") }),
      );
      expect(outcome).toMatch(/delivery fees do not follow/);
    });
  });

  describe("review 2, finding 5: publication is screened; user sellers hold finite stock", () => {
    let draftId: string;
    let draftV2: string;
    beforeAll(async () => {
      const d = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 700n * RUPEE });
      draftId = d.id;
      await pool.query("UPDATE core.product SET status = 'DRAFT' WHERE id = $1", [d.id]);
      draftV2 = uuidv7();
      await pool.query(
        `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
         VALUES ($1, $2, 2, 'Moon Lamp', 'Even more moon.', 'A round lamp', 1, 80000)`,
        [draftV2, d.id],
      );
    });
    const move = (id: string, to: string) => `UPDATE core.product SET status = '${to}' WHERE id = '${id}'`;
    const atStatus = async (status: string) => {
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 700n * RUPEE });
      await pool.query("UPDATE core.product SET status = $2 WHERE id = $1", [p.id, status]);
      return p.id;
    };

    it("a USER product may never have unlimited stock, whoever writes it", async () => {
      expect(
        await stateOf(
          pool,
          `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode)
           VALUES ($1, $2, 'USER', 'DRAFT', 'gadgets', 'UNLIMITED_SEED')`,
          [uuidv7(), s.companyId],
        ),
      ).toBe("23514");
      expect(
        await stateOf(pool, "UPDATE core.product SET inventory_mode = 'UNLIMITED_SEED' WHERE id = $1", [
          draftId,
        ]),
      ).toBe("23514");
    });

    it("app_web (the owner) may only move DRAFT -> SCREENING and PUBLISHED -> ARCHIVED", async () => {
      const owner = web(s.owner);
      for (const to of ["PUBLISHED", "NEEDS_REVIEW", "REJECTED", "HIDDEN", "ARCHIVED"]) {
        expect(await stateOf(pool, move(draftId, to), [], owner), `DRAFT -> ${to}`).toBe("42501");
      }
      expect(await stateOf(pool, move(draftId, "SCREENING"), [], owner)).toBe("no error");
      const published = await atStatus("PUBLISHED");
      for (const to of ["HIDDEN", "DRAFT", "SCREENING", "REJECTED"]) {
        expect(await stateOf(pool, move(published, to), [], owner), `PUBLISHED -> ${to}`).toBe("42501");
      }
      expect(await stateOf(pool, move(published, "ARCHIVED"), [], owner)).toBe("no error");
      const screening = await atStatus("SCREENING");
      for (const to of ["PUBLISHED", "NEEDS_REVIEW", "REJECTED", "DRAFT"]) {
        expect(await stateOf(pool, move(screening, to), [], owner), `SCREENING -> ${to}`).toBe("42501");
      }
      // the screening job and moderation (app_jobs) set them
      for (const to of ["PUBLISHED", "NEEDS_REVIEW", "REJECTED"]) {
        expect(await stateOf(pool, move(screening, to), [], { role: "app_jobs" }), to).toBe("no error");
      }
      expect(await stateOf(pool, move(published, "HIDDEN"), [], { role: "app_jobs" })).toBe("no error");
    });

    it("app_web creates products only as DRAFT", async () => {
      const insert = (status: string) =>
        `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode)
         VALUES ('${uuidv7()}', '${s.companyId}', 'USER', '${status}', 'gadgets', 'STANDARD_STOCKED')`;
      expect(await stateOf(pool, insert("DRAFT"), [], web(s.owner))).toBe("no error");
      for (const status of ["PUBLISHED", "SCREENING", "HIDDEN"]) {
        expect(await stateOf(pool, insert(status), [], web(s.owner)), status).toBe("42501");
      }
    });

    it("current_version_id changes only with a status move the role may make, and only to a version of the product", async () => {
      const owner = web(s.owner);
      expect(
        await stateOf(
          pool,
          "UPDATE core.product SET current_version_id = $2 WHERE id = $1",
          [draftId, draftV2],
          owner,
        ),
      ).toBe("42501");
      expect(
        await stateOf(
          pool,
          "UPDATE core.product SET status = 'SCREENING', current_version_id = $2 WHERE id = $1",
          [draftId, draftV2],
          owner,
        ),
      ).toBe("no error");
      expect(
        await stateOf(
          pool,
          "UPDATE core.product SET status = 'SCREENING', current_version_id = $2 WHERE id = $1",
          [draftId, crorePiece.versionId],
          owner,
        ),
      ).toBe("23514");
      // the screening job may switch the version, but only to one of the product's own
      expect(
        await stateOf(
          pool,
          "UPDATE core.product SET current_version_id = $2 WHERE id = $1",
          [draftId, draftV2],
          {
            role: "app_jobs",
          },
        ),
      ).toBe("no error");
      expect(
        await stateOf(
          pool,
          "UPDATE core.product SET current_version_id = $2 WHERE id = $1",
          [draftId, crorePiece.versionId],
          { role: "app_jobs" },
        ),
      ).toBe("23514");
    });
  });

  describe("review 2, finding 6: nothing waits unboundedly", () => {
    it("the application roles carry session defaults for idle transactions, lock waits and statements", async () => {
      const { rows } = await pool.query<{ role: string; settings: string[] }>(
        `SELECT r.rolname AS role, array(SELECT unnest(s.setconfig) ORDER BY 1) AS settings
           FROM pg_db_role_setting s
           JOIN pg_roles r ON r.oid = s.setrole
           JOIN pg_database d ON d.oid = s.setdatabase AND d.datname = current_database()
          ORDER BY 1`,
      );
      const expected = (statement: string) => [
        "idle_in_transaction_session_timeout=15s",
        "lock_timeout=2s",
        `statement_timeout=${statement}`,
      ];
      expect(rows).toEqual([
        { role: "app_jobs", settings: expected("60s") },
        { role: "app_pay", settings: expected("10s") },
        { role: "app_web", settings: expected("10s") },
        { role: "npc_worker", settings: expected("10s") },
      ]);
    });

    it("ledger.sync_wallets gives up on a held wallet after 2 s, whatever lock_timeout the caller set", async () => {
      const holder = await pool.connect();
      const caller = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE", [
          buyer.ledgerAccountId,
        ]);
        await caller.query("BEGIN");
        await caller.query("SELECT set_config('app.user_id', $1, true)", [buyer.userId]);
        await caller.query("SET LOCAL ROLE app_pay");
        await caller.query("SET LOCAL lock_timeout = 0"); // the caller asks to wait forever
        await caller.query("SET LOCAL statement_timeout = '8s'"); // (bounds the test if the function waits)
        const started = Date.now();
        const state = await sqlState(
          caller.query("SELECT ledger.sync_wallets($1)", [[buyer.ledgerAccountId]]),
        );
        expect({ state, quick: Date.now() - started < 5_000 }).toEqual({ state: "55P03", quick: true });
      } finally {
        await caller.query("ROLLBACK").catch(() => undefined);
        await holder.query("ROLLBACK");
        caller.release();
        holder.release();
      }
    });

    it("pay() takes wallet locks last: a purchase refused in validation never waits on a held wallet", async () => {
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 500n * RUPEE });
      const co = await checkout(pool, accomplice, [p], standard(s));
      await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [p.id]);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE", [
          accomplice.ledgerAccountId,
        ]);
        expect(await codeOf(payFor(pool, accomplice, co))).toBe("PRODUCT_UNAVAILABLE");
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
  });

  describe("review 2, finding 7: the database checks the amounts the reviewer found untested", () => {
    let freeStd: ProductFixture;
    let flatId: string;
    let minSpendId: string;
    beforeAll(async () => {
      freeStd = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 5_000n * RUPEE,
        freeStd: true,
      });
      flatId = uuidv7();
      minSpendId = uuidv7();
      await pool.query(
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value, min_spend_paise) VALUES
           ($1, 'MERCHANT', $3, 'FLAT5CR', 'FLAT', $4, 0),
           ($2, 'MERCHANT', $3, 'BIGSPEND', 'PERCENT', 10, $5)`,
        [flatId, minSpendId, s.companyId, (5n * CRORE).toString(), (20n * CRORE).toString()],
      );
    });

    it("(a) each seller credit equals its seller order's net (the shortfall paid to SINK instead)", async () => {
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, { creditShortfall: 1_000n * RUPEE }),
        ),
      ).toMatch(/seller credit does not equal its seller order's net/);
    });

    it("(b) a FLAT coupon gives exactly its amount (capped at ₹100 a line); never more", async () => {
      const flat = (discount: bigint) => ({ sellerDiscount: discount, coupon: { id: flatId, discount } });
      expect(await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, flat(5n * CRORE)))).toBe(
        "no error",
      );
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, flat(5n * CRORE + 1_000n * RUPEE)),
        ),
      ).toMatch(/not what coupon .* gives/);
    });

    it("(b) a coupon's minimum spend is checked by the database", async () => {
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, { sellerDiscount: CRORE, coupon: { id: minSpendId, discount: CRORE } }),
        ),
      ).toMatch(/minimum spend/);
    });

    it("(b) the redemption records the discount the lines give", async () => {
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, { sellerDiscount: CRORE, coupon: { id: couponId, discount: 1n } }),
        ),
      ).toMatch(/redemption records/);
    });

    it("(c) delivery fees: the buyer pays the configured fee, or the seller does when it offers free Standard", async () => {
      const on = (o: Forge) =>
        commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, { product: freeStd, ...o }));
      expect(await on({ deliverySeller: DELIVERY.STANDARD })).toBe("no error"); // merchant-funded (control)
      expect(await on({})).toMatch(/delivery fees do not follow/); // buyer charged although free
      expect(await on({ deliverySeller: DELIVERY.STANDARD / 2n })).toMatch(/delivery fees do not follow/);
      // not free: the buyer pays exactly the configured fee
      expect(
        await commitError(pool, payAs(buyer), (c) =>
          forgePurchase(c, buyer, { deliveryBuyer: DELIVERY.STANDARD - RUPEE }),
        ),
      ).toMatch(/delivery fees do not follow/);
    });
  });

  describe("review 2, finding 8: buyer source, progression, shipment schedule and the FLAT split", () => {
    let testBuyer: ProvisionResult;
    beforeAll(async () => {
      testBuyer = await user(pool);
      await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [
        testBuyer.userId,
      ]);
    });

    it("buyer_source is STAFF exactly for a test account", async () => {
      expect(
        await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, { buyerSource: "STAFF" })),
      ).toMatch(/buyer_source must be STAFF/);
      expect(
        await commitError(pool, payAs(testBuyer), (c) => forgePurchase(c, testBuyer, { qualifies: false })),
      ).toMatch(/buyer_source must be STAFF/);
    });

    it("a test account's purchase does not qualify for progression", async () => {
      expect(
        await commitError(pool, payAs(testBuyer), (c) =>
          forgePurchase(c, testBuyer, { buyerSource: "STAFF" }),
        ),
      ).toMatch(/does not qualify for progression/);
      expect(
        await commitError(pool, payAs(testBuyer), (c) =>
          forgePurchase(c, testBuyer, { buyerSource: "STAFF", qualifies: false }),
        ),
      ).toBe("no error");
    });

    it("pay() records a test account's purchase as STAFF and not qualifying", async () => {
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 300n * RUPEE });
      const receipt = await payFor(pool, testBuyer, await checkout(pool, testBuyer, [p], standard(s)));
      const { rows } = await pool.query<{ buyer_source: string; qualifies_for_progression: boolean }>(
        `SELECT g.buyer_source, so.qualifies_for_progression FROM core.order_group g
           JOIN core.seller_order so ON so.order_group_id = g.id WHERE g.id = $1`,
        [receipt.orderGroupId],
      );
      expect(rows).toEqual([{ buyer_source: "STAFF", qualifies_for_progression: false }]);
    });

    it("the shipment follows the schedule for its speed from the journal's time (within one second)", async () => {
      expect(
        await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, { deliveredSkewMs: -60_000 })),
      ).toMatch(/shipment does not follow the STANDARD schedule/);
      expect(
        await commitError(pool, payAs(buyer), (c) => forgePurchase(c, buyer, { deliveredSkewMs: 500 })),
      ).toBe("no error");
    });

    it("a FLAT coupon is split across lines exactly as the pricing function splits it", async () => {
      const a = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 3_001n * RUPEE });
      const b = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 5_003n * RUPEE });
      const amount = 1_000n * RUPEE + 7n;
      const id = uuidv7();
      await pool.query(
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, kind, value) VALUES ($1, 'MERCHANT', $2, $3, 'FLAT', $4)`,
        [id, s.companyId, `SPLIT${randomBytes(2).toString("hex").toUpperCase()}`, amount.toString()],
      );
      const priced = price({
        lines: [a, b].map((p) => ({
          productId: p.id,
          sellerId: s.companyId,
          listPaise: p.pricePaise,
          freeStdDelivery: false,
        })),
        coupon: {
          scope: "MERCHANT",
          companyId: s.companyId,
          discount: { kind: "FLAT", amountPaise: amount },
        },
        speedBySeller: new Map([[s.companyId, "STANDARD"]]),
        isMember: false,
        cfg: DEFAULT_PRICING_CONFIG,
      });
      const split = priced.lines.map((l) => l.sellerDisc);
      const forge = (lineDiscounts: bigint[]) => (c: pg.PoolClient) =>
        forgePurchase(c, buyer, { products: [a, b], lineDiscounts, coupon: { id, discount: amount } });
      expect(await commitError(pool, payAs(buyer), forge(split))).toBe("no error");
      const [x = 0n, y = 0n] = split;
      expect(await commitError(pool, payAs(buyer), forge([x - 100n, y + 100n]))).toMatch(
        /not split across the lines/,
      );
    });

    it("property: core.flat_split equals the pricing function's FLAT split for random carts", async () => {
      let seed = 0x5eed_1234;
      const rand = (n: number) => {
        seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; // deterministic: injected randomness
        return seed % n;
      };
      for (let i = 0; i < 150; i++) {
        const n = 1 + rand(6);
        const lists = Array.from({ length: n }, () =>
          rand(3) === 0 ? 10_000n + BigInt(rand(5)) * 100n : BigInt(100 + rand(2_000_000)) * 100n,
        );
        const room = lists.reduce((t, l) => t + (l > 10_000n ? l - 10_000n : 0n), 0n);
        const amount = 1n + (room > 0n ? (room * BigInt(rand(150))) / 100n : BigInt(rand(1_000_000)));
        const priced = price({
          lines: lists.map((l, k) => ({
            productId: `p${k}`,
            sellerId: "co",
            listPaise: l,
            freeStdDelivery: false,
          })),
          coupon: { scope: "MERCHANT", companyId: "co", discount: { kind: "FLAT", amountPaise: amount } },
          speedBySeller: new Map([["co", "STANDARD"]]),
          isMember: false,
          cfg: DEFAULT_PRICING_CONFIG,
        });
        const { rows } = await pool.query<{ split: string[] }>(
          "SELECT core.flat_split($1::bigint, $2::bigint[])::text[] AS split",
          [amount.toString(), lists.map(String)],
        );
        expect(rows[0]?.split.map(BigInt), `case ${i}`).toEqual(priced.lines.map((l) => l.sellerDisc));
      }
    });
  });

  // -------------------------------------------------------------------------------- known gap
  // Not fixed: needs sign-in. See the comment block at the top of migrations/0011_grants.sql.
  describe("requires auth integration", () => {
    it.todo(
      "app_pay cannot choose the acting user: app.user_id is replaced by a definer function that verifies an auth-service-signed session token (asymmetric; the web process holds only the public key)",
    );
    it.todo(
      "with the app_pay credential, an attacker cannot spend another user's wallet by naming them as the actor",
    );
    it.todo(
      "app_pay cannot provision an invented user: core.user_profile.id has a foreign key to the auth service's user table",
    );
  });

  // -------------------------------------------------------------------------------- privilege catalogue
  describe("the privilege split", () => {
    it("app_web is not a member of app_pay and cannot become it", async () => {
      const { rows } = await pool.query<{ member: boolean; usage: boolean }>(
        "SELECT pg_has_role('app_web', 'app_pay', 'MEMBER') AS member, pg_has_role('app_web', 'app_pay', 'USAGE') AS usage",
      );
      expect(rows[0]).toEqual({ member: false, usage: false });
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        await c.query("SET SESSION AUTHORIZATION app_web");
        expect(await sqlState(c.query("SET ROLE app_pay"))).toBe("42501");
      } finally {
        await c.end();
      }
    });

    it("app_web holds no write on money, order, payment, stock or card tables and cannot run the pay helpers", async () => {
      const tables = [
        "ledger.journal",
        "ledger.posting",
        "ledger.wallet",
        "ledger.grant_record",
        "ledger.ledger_account",
        "core.checkout_session",
        "core.payment_attempt",
        "core.payment_challenge",
        "core.idempotency_record",
        "core.order_group",
        "core.seller_order",
        "core.order_line",
        "core.ownership",
        "core.shipment",
        "core.coupon_redemption",
        "core.creator_entitlement",
        "core.inventory_unit",
        "core.bank_account",
        "core.virtual_card",
      ];
      const { rows } = await pool.query<{ t: string; p: string }>(
        `SELECT t, p FROM unnest($1::text[]) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
          WHERE CASE WHEN p IN ('INSERT','UPDATE') THEN has_any_column_privilege('app_web', t, p)
                     ELSE has_table_privilege('app_web', t, p) END`,
        [tables],
      );
      expect(rows).toEqual([]);
      const counters = await pool.query<{ c: string }>(
        `SELECT t || '.' || col AS c FROM (VALUES ('core.product', 'available_units'), ('core.coupon', 'redeemed'),
                                                  ('core.warehouse', 'used'), ('core.promo_campaign', 'spent_paise')) v(t, col)
          WHERE has_column_privilege('app_web', t, col, 'UPDATE') OR has_column_privilege('app_web', t, col, 'INSERT')`,
      );
      expect(counters.rows).toEqual([]);
      const fns = await pool.query<{ f: string }>(
        `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('core','ledger') AND p.prosecdef AND has_function_privilege('app_web', p.oid, 'EXECUTE')
          ORDER BY 1`,
      );
      // only the read-only questions RLS policies ask
      expect(fns.rows.map((r) => r.f)).toEqual([
        "core.identity_is_tombstoned(bytea,bytea)",
        "core.is_published_version(uuid)",
      ]);
    });
  });
});
