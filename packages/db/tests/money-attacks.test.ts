import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCheckoutSession, createPaymentAttempt, markAttemptAuthenticated, pay } from "../src/checkout";
import { MINT_ACCOUNT_ID, type ProvisionResult, SINK_ACCOUNT_ID } from "../src/provision";
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

  // -------------------------------------------------------------------------------- (1) minting
  describe("attack 1: minting money", () => {
    for (const type of ["COMPANY_REGISTRATION", "WAREHOUSE_PURCHASE", "MEMBERSHIP", "PURCHASE"]) {
      it(`a ${type} journal posting MINT -> self: app_web has no privilege, app_pay is refused at commit`, async () => {
        const mint = (c: pg.PoolClient) =>
          journal(c, type, [
            [MINT_ACCOUNT_ID, -CRORE],
            [buyer.ledgerAccountId, CRORE],
          ]);
        expect(await commitState(pool, web(buyer), mint)).toBe("42501");
        expect(await commitError(pool, payAs(buyer), mint)).toMatch(
          new RegExp(`${type} journal .* may not post to MINT`),
        );
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
        expect(await commitError(pool, payAs(buyer), steal)).toMatch(
          /may debit only the acting user's own account/,
        );
      });
    }

    it("a seller's money cannot be routed through SINK either", async () => {
      const viaSink = (c: pg.PoolClient) =>
        journal(c, "MEMBERSHIP", [
          [s.owner.ledgerAccountId, -CRORE],
          [SINK_ACCOUNT_ID, CRORE],
        ]);
      expect(await commitError(pool, payAs(buyer), viaSink)).toMatch(/acting user's own account/);
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
    product?: ProductFixture;
    list?: bigint;
    sellerDiscount?: bigint;
    fee?: bigint;
    speed?: Speed;
    deliveryBuyer?: bigint;
    creditAccount?: string;
    journal?: boolean;
    succeed?: boolean;
    coupon?: { id: string; discount: bigint };
  }

  /**
   * A whole purchase written by hand as app_pay, the way pay() writes it. With no options it
   * is a correct purchase of crorePiece (the control); each option tampers with one part.
   */
  async function forgePurchase(c: pg.PoolClient, who: ProvisionResult, o: Forge = {}): Promise<void> {
    const p = o.product ?? crorePiece;
    const list = o.list ?? p.pricePaise;
    const sd = o.sellerDiscount ?? 0n;
    const fee = o.fee ?? ((list - sd) * 5n) / 100n;
    const speed = o.speed ?? "STANDARD";
    const db = o.deliveryBuyer ?? DELIVERY[speed];
    const net = list - sd - fee;
    const total = list - sd + db;
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
          net.toString(),
          so,
          SINK_ACCOUNT_ID,
          (fee + db).toString(),
        ],
      );
      await c.query("SELECT ledger.sync_wallets($1)", [[who.ledgerAccountId, credit]]);
    }
    await c.query(
      `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
       VALUES ($1, $2, $3, $4, $5, 'PLAYER', $6, 1)`,
      [group, who.userId, session, attempt, journalId, total.toString()],
    );
    await c.query(
      `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise,
         seller_discount_paise, fee_paise, delivery_fee_buyer_paise, net_paise)
       VALUES ($1, $2, $3, $4, 'USER', $5, $6, $7, $8, $9)`,
      [
        so,
        group,
        who.userId,
        s.companyId,
        list.toString(),
        sd.toString(),
        fee.toString(),
        db.toString(),
        net.toString(),
      ],
    );
    const unit = await c.query<{ id: string; warehouse_id: string }>(
      `SELECT id, warehouse_id FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE'
        ORDER BY serial LIMIT 1 FOR UPDATE`,
      [p.id],
    );
    const u = unit.rows[0];
    if (!u) throw new Error("fixture: no unit left");
    await c.query(
      `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
         seller_discount_paise, platform_discount_paise, fee_paise, inventory_unit_id)
       VALUES ($1, $2, $3, $4, '{}', $5, $6, 0, $7, $8)`,
      [line, so, p.id, p.versionId, list.toString(), sd.toString(), fee.toString(), u.id],
    );
    await c.query(
      "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
      [uuidv7(), who.userId, p.id, line],
    );
    await c.query("UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = $2 WHERE id = $1", [
      u.id,
      line,
    ]);
    await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [p.id]);
    await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [u.warehouse_id]);
    if (o.coupon) {
      await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [o.coupon.id]);
      await c.query(
        "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, $4)",
        [o.coupon.id, who.userId, group, o.coupon.discount.toString()],
      );
    }
    await c.query(
      `INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at)
       VALUES ($1, $2, $3, now(), now(), now(), now(), now())`,
      [uuidv7(), so, speed],
    );
    if (o.succeed !== false) {
      await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [attempt]);
      await c.query("UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = $1", [session]);
    }
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
    const edits: [string, string, () => unknown[], RegExp][] = [
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
      ],
      [
        "warehouse.used",
        "UPDATE core.warehouse SET used = used + 1 WHERE id = $1",
        () => [s.warehouseId],
        /used must equal/,
      ],
    ];
    for (const [label, sql, params, why] of edits) {
      it(`${label}: no privilege for app_web, inconsistent for app_pay`, async () => {
        expect(await commitState(pool, web(buyer), (c) => c.query(sql, params()))).toBe("42501");
        expect(await commitError(pool, payAs(buyer), (c) => c.query(sql, params()))).toMatch(why);
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
