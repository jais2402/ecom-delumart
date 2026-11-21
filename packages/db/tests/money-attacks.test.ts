import { randomBytes } from "node:crypto";
import { DEFAULT_DELIVERY_DURATIONS_MS, DEFAULT_PRICING_CONFIG, price } from "@delulu/core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyCardPin } from "../src/card";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import { MINT_ACCOUNT_ID, SINK_ACCOUNT_ID } from "../src/provision";
import { type TransactionOptions, withTransaction } from "../src/transaction";
import {
  authenticateCard,
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
  TEST_PIN_MAC,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  type Actor,
  asActor,
  become,
  commitError,
  commitState,
  countRows,
  createTestDatabase,
  plant,
  provisionAccount,
  provisionInput,
  RAW_WRITER,
  sessionFor,
  sqlState,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

/**
 * Security review of the money path, replayed. Each attack is run as app_web and as app_pay
 * (the money-command role): both must be denied by privilege, since neither writes a money
 * table directly any more (migration 0011; app_pay only executes the command functions of
 * 0018). Each raw-SQL attack is then run again as a deliberately over-privileged writer
 * (RAW_WRITER, tests/helpers.ts: every table privilege, BYPASSRLS), which the structural rules
 * of migration 0016 and the seals must refuse on their own. The acting user is always derived
 * from a sign-in session (core.actor_id()), never named by the connection.
 */
const RELIEF = 100_000_000n;
const DELIVERY = { STANDARD: 1_000n * RUPEE, EXPRESS: 10_000n * RUPEE, ZAP: 50_000n * RUPEE } as const;
type Speed = keyof typeof DELIVERY;

const web = (u: TestUser): Actor => ({ role: "app_web", userId: u.userId });
const payAs = (u: TestUser): Actor => ({ role: "app_pay", userId: u.userId });
/** a writer the grants did not stop: only the structural rules stand in its way */
const rawAs = (u: TestUser): Actor => ({ role: RAW_WRITER, userId: u.userId });

describe("money attacks (security review)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let buyer: TestUser;
  let s: Seller;
  let crorePiece: ProductFixture; // ₹10 crore, stocked
  let couponId: string;
  let couponCode: string; // private: generated (0020)
  let accomplice: TestUser;

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
    ({ id: couponId, code: couponCode } = await merchantCoupon(pool, s, { percent: 10 }));
    accomplice = await user(pool);
  });
  afterEach(async () => {
    expect(await reconcile(pool)).toEqual(CLEAN);
  });
  afterAll(async () => {
    await db.drop();
  });

  /** A user provisioned while tombstoned: wallet 0, no STARTER grant (eligible for relief). */
  async function poorUser(): Promise<TestUser> {
    const input = provisionInput();
    await pool.query(
      "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '30 days')",
      [input.emailFingerprint],
    );
    return provisionAccount(pool, input);
  }

  /**
   * What the pricing function gives for these lines (Standard delivery, no coupon, not a member),
   * serialised as core.commit_purchase takes it (as packages/db/src/checkout.ts sends it).
   */
  function pricedFor(lines: { p: ProductFixture; seller: string }[]): unknown {
    const priced = price({
      lines: lines.map(({ p, seller }) => ({
        productId: p.id,
        sellerId: seller,
        listPaise: p.pricePaise,
        freeStdDelivery: false,
      })),
      speedBySeller: new Map(lines.map(({ seller }) => [seller, "STANDARD" as const])),
      isMember: false,
      cfg: DEFAULT_PRICING_CONFIG,
    });
    return {
      lines: priced.lines.map((l) => ({
        productId: l.productId,
        sellerId: l.sellerId,
        listPaise: l.listPaise.toString(),
        sellerDisc: l.sellerDisc.toString(),
        platformDisc: l.platformDisc.toString(),
        fee: l.fee.toString(),
      })),
      sellers: priced.perSeller.map((x) => ({
        sellerId: x.sellerId,
        speed: x.speed,
        list: x.list.toString(),
        sellerDisc: x.sellerDisc.toString(),
        platformDisc: x.platformDisc.toString(),
        fee: x.fee.toString(),
        deliveryBuyer: x.deliveryBuyer.toString(),
        deliverySeller: x.deliverySeller.toString(),
        net: x.net.toString(),
      })),
      postings: priced.postings.map((x) => ({ account: x.account, amount: x.amountPaise.toString() })),
      total: priced.buyerTotal.toString(),
    };
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

  const relief = (c: pg.PoolClient, who: TestUser, amount: bigint) =>
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
  const nameCoupon = (c: pg.PoolClient, who: TestUser, id: string) =>
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
        expect(await commitState(pool, payAs(buyer), mint)).toBe("42501");
        if (type === "PURCHASE") {
          expect(await commitError(pool, rawAs(buyer), mint)).toMatch(
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
      expect(await commitState(pool, payAs(poor), (c) => relief(c, poor, 100n * CRORE))).toBe("42501");
      expect(await commitError(pool, rawAs(poor), (c) => relief(c, poor, 100n * CRORE))).toMatch(
        /RELIEF_GRANT is exactly 100000000 paise/,
      );
      expect(await commitError(pool, rawAs(poor), (c) => relief(c, poor, RELIEF - 1n))).toMatch(/exactly/);
      // the genuine relief for a user below the ceiling commits (control)
      expect(await commitState(pool, rawAs(poor), (c) => relief(c, poor, RELIEF))).toBe("no error");
    });

    it("relief is refused while the wallet is at or above the ceiling", async () => {
      expect(await commitError(pool, rawAs(buyer), (c) => relief(c, buyer, RELIEF))).toMatch(
        /only for a balance below/,
      );
    });

    it("relief: one per user per UTC day, at most 7 per lifetime", async () => {
      const poor = await poorUser();
      expect(
        await commitState(pool, rawAs(poor), async (c) => {
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
      expect(await commitError(pool, rawAs(poor), (c) => relief(c, poor, RELIEF))).toMatch(
        /at most 7 relief grants/,
      );
    });

    it("relief may not be paid to another user, nor dated another day", async () => {
      const poor = await poorUser();
      expect(await commitError(pool, rawAs(buyer), (c) => relief(c, poor, RELIEF))).toMatch(
        /row-level security|acting user/,
      );
      const otherDay = await commitError(pool, rawAs(poor), (c) =>
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
      const starter = (who: TestUser) => (c: pg.PoolClient) =>
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
      expect(await commitError(pool, rawAs(poor), starter(poor))).toMatch(/only when the account is opened/);
      expect(await commitState(pool, rawAs(buyer), starter(buyer))).toBe("23505"); // one_starter
      expect(await commitState(pool, payAs(buyer), starter(buyer))).toBe("42501");
    });

    for (const type of ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"]) {
      it(`only the database owner creates ${type} journals (not even the job runner)`, async () => {
        const insert = "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)";
        expect(await stateOf(pool, insert, [uuidv7(), type], web(buyer))).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], payAs(buyer))).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], { role: "app_jobs" })).toBe("42501");
        expect(await stateOf(pool, insert, [uuidv7(), type], {})).toBe("no error");
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
        expect(await commitState(pool, payAs(buyer), steal)).toBe("42501");
        if (type === "PURCHASE") {
          expect(await commitError(pool, rawAs(buyer), steal)).toMatch(
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

    it("ledger.sync_wallets is not executable by app_web or app_pay, and refuses arbitrary users' wallets to anyone", async () => {
      const bystander = await user(pool);
      const sync = "SELECT ledger.sync_wallets($1)";
      expect(await stateOf(pool, sync, [[bystander.ledgerAccountId]], web(buyer))).toBe("42501");
      expect(await stateOf(pool, sync, [[bystander.ledgerAccountId]], payAs(buyer))).toBe("42501");
      expect(await stateOf(pool, sync, [[buyer.ledgerAccountId]], payAs(buyer))).toBe("42501");
      // the function's own rule, for a caller that may execute it
      expect(await stateOf(pool, sync, [[bystander.ledgerAccountId]], rawAs(buyer))).toBe("42501");
      expect(
        await stateOf(pool, sync, [[buyer.ledgerAccountId, s.owner.ledgerAccountId]], rawAs(buyer)),
      ).toBe("no error");
    });
  });

  // -------------------------------------------------------------------------------- (3) forged quotes
  describe("attack 3: a forged checkout session is not honoured by pay()", () => {
    /**
     * A session with a hand-written quote. app_pay cannot insert one at all (asserted); it is
     * written by a writer the grants did not stop, then paid for through the API, so pay()
     * itself is shown not to honour it. The BALANCE attempt goes through the API.
     */
    async function forgedSession(who: TestUser, quote: unknown, totalPaise: bigint) {
      const sessionId = uuidv7();
      const insert = (c: pg.PoolClient) =>
        c.query(
          `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
           VALUES ($1, $2, 'PRODUCT_PURCHASE', $3, $4, 1, now() + interval '5 minutes')`,
          [sessionId, who.userId, JSON.stringify(quote), totalPaise.toString()],
        );
      expect(await commitState(pool, payAs(who), insert)).toBe("42501");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await become(c, rawAs(who));
        await insert(c);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const attempt = await createPaymentAttempt(pool, {
        authSessionId: who.authSessionId,
        sessionId,
        method: "BALANCE",
      });
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

    it("neither app_web nor app_pay can insert a checkout session at all", async () => {
      for (const as of [web(buyer), payAs(buyer)]) {
        expect(
          await stateOf(
            pool,
            `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
             VALUES ($1, $2, 'PRODUCT_PURCHASE', '{}', 1, 1, now() + interval '5 minutes')`,
            [uuidv7(), buyer.userId],
            as,
          ),
          as.role,
        ).toBe("42501");
      }
    });

    it("a ₹10 crore item quoted at ₹1,100 through a fake coupon value is refused with CART_CHANGED, nothing debited", async () => {
      const victim = await user(pool);
      const forged = quoteFor(crorePiece, s.companyId, {
        coupon: {
          id: couponId,
          companyId: s.companyId,
          code: couponCode,
          kind: "FLAT",
          value: "99999999999",
          minSpendPaise: "0",
        },
      });
      const co = await forgedSession(victim, forged, 1_100n * RUPEE);
      const before = await wallet(pool, victim.ledgerAccountId);
      const outcome = await codeOf(
        pay(pool, {
          authSessionId: victim.authSessionId,
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
          authSessionId: victim.authSessionId,
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
            authSessionId: victim.authSessionId,
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
      const { id, code } = await merchantCoupon(pool, s, { percent: 20 });
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const co = await checkout(pool, victim, [p], standard(s), code);
      await pool.query("UPDATE core.coupon SET status = 'PAUSED' WHERE id = $1", [id]);
      expect(await codeOf(payFor(pool, victim, co))).toBe("COUPON_INVALID");
    });

    it("amounts handed to the database are re-derived there: a cheaper quote or order than the pricing rules give is refused and stores nothing", async () => {
      const victim = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 9_000n * RUPEE });
      const honest = pricedFor([{ p: seed, seller: "SEED" }]) as {
        total: string;
        sellers: { list: string }[];
      };
      const cheap = {
        ...honest,
        total: "10000",
        sellers: honest.sellers.map((x) => ({ ...x, list: "100" })),
      };
      const choices = {
        productIds: [seed.id],
        speedBySeller: standard("SEED"),
        couponCode: null,
        addressId: null,
      };
      const stored = async (priced: unknown) =>
        asActor(pool, payAs(victim), async (c) => {
          const state = await sqlState(
            c.query("SELECT core.create_checkout_session($1::jsonb, $2)", [
              JSON.stringify({ ...choices, priced }),
              key(),
            ]),
          );
          if (state !== "no error") return { state, sessions: 0 };
          return { state, sessions: await countRows(c, "SELECT count(*) AS n FROM core.checkout_session") };
        });
      expect(await stored(cheap)).toEqual({ state: "23514", sessions: 0 });
      expect(await stored(null)).toEqual({ state: "23514", sessions: 0 });
      expect(await stored(honest)).toEqual({ state: "no error", sessions: 1 }); // control
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.checkout_session WHERE user_id = $1", [
          victim.userId,
        ]),
      ).toBe(0);
      // pay: an order that differs from what the locked rows give is retryable (BUSY), never stored
      const co = await checkout(pool, victim, [seed], standard("SEED"));
      const before = await wallet(pool, victim.ledgerAccountId);
      const paid = await asActor(pool, payAs(victim), async (c) => ({
        cheap: await sqlState(
          c.query("SELECT core.commit_purchase($1, $2, 'k1', '\\x01', $3::jsonb)", [
            co.sessionId,
            co.attemptId,
            JSON.stringify(cheap),
          ]),
        ),
      }));
      expect(paid).toEqual({ cheap: "40001" });
      expect(await wallet(pool, victim.ledgerAccountId)).toBe(before);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.order_group WHERE session_id = $1", [co.sessionId]),
      ).toBe(0);
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
    /** debited from the buyer beyond the order total and paid to SINK (the journal still balances) */
    overcharge?: bigint;
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
   * A whole purchase written by hand, the way core.commit_purchase writes it (run as RAW_WRITER:
   * app_pay holds none of these privileges). With no options it is a correct purchase of
   * crorePiece (the control); each option tampers with one part.
   */
  async function forgePurchase(c: pg.PoolClient, who: TestUser, o: Forge = {}): Promise<void> {
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
    const overcharge = o.overcharge ?? 0n;
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
          (-(total + overcharge)).toString(),
          credit,
          (net - shortfall).toString(),
          so,
          SINK_ACCOUNT_ID,
          (fee + db + dsel + shortfall + overcharge).toString(),
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
      expect(await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer))).toBe("no error");
    });

    it("refused at commit: a purchase while purchases are switched off", async () => {
      await pool.query("UPDATE core.system_switch SET enabled = false WHERE name = 'purchases'");
      try {
        expect(await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer))).toMatch(/switched off/);
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
        expect(await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, o))).toMatch(why);
      });
    }

    it("refused at commit: a genuine coupon redeemed for more than it gives", async () => {
      const message = await commitError(pool, rawAs(buyer), (c) =>
        forgePurchase(c, buyer, {
          sellerDiscount: 10n * CRORE - 100n * RUPEE,
          coupon: { id: couponId, discount: 10n * CRORE - 100n * RUPEE },
        }),
      );
      expect(message).toMatch(/not what coupon/);
      // the same coupon applied as it really applies (10%) passes
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
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

      /** app_web and app_pay: no privilege; `pay` is what the structural rules say to a raw writer */
      const both = async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
        expect(await commitState(pool, payAs(buyer), fn)).toBe("42501");
        return {
          web: await commitState(pool, web(buyer), fn),
          pay: await commitError(pool, rawAs(buyer), fn),
        };
      };

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
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/sealed|created in this transaction/) });
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
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/sealed|created in this transaction/) });
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
        const { id: capped } = await merchantCoupon(pool, s, { percent: 5, maxRedemptions: 1 });
        const r = await both(async (c) => {
          // the attacker names the coupon in a session of their own so app_pay may touch it
          await nameCoupon(c, buyer, capped);
          await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [capped]);
          await c.query(
            "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, 0)",
            [capped, buyer.userId, paid.groupId],
          );
        });
        expect(r).toEqual({ web: "42501", pay: expect.stringMatching(/sealed|created in this transaction/) });
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
        const back = await commitError(pool, rawAs(buyer), async (c) => {
          await c.query("UPDATE core.payment_attempt SET state = 'FAILED' WHERE id = $1", [co.attemptId]);
          await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [co.attemptId]);
        });
        expect(back).toMatch(/final/);
        expect(
          await commitError(pool, rawAs(buyer), (c) =>
            c.query("UPDATE core.checkout_session SET state = 'OPEN' WHERE id = $1", [paid.sessionId]),
          ),
        ).toMatch(/may move only OPEN/);
      });
    });
  });

  // -------------------------------------------------------------------------------- (6) card attempts
  describe("attack 6: card attempts", () => {
    async function openSession(who: TestUser): Promise<string> {
      const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const session = await createCheckoutSession(pool, {
        authSessionId: who.authSessionId,
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
      expect(await commitState(pool, payAs(buyer), insert)).toBe("42501");
      expect(await commitError(pool, rawAs(buyer), insert)).toMatch(/authentication is a separate step/);
    });

    it("authentication is stamped by the database clock, once", async () => {
      const sessionId = await openSession(buyer);
      const attempt = await createPaymentAttempt(pool, {
        authSessionId: buyer.authSessionId,
        sessionId,
        method: "CARD",
        cardId: buyer.cardId,
      });
      await authenticateCard(pool, buyer, attempt.attemptId);
      const { rows } = await pool.query<{ recent: boolean }>(
        "SELECT authenticated_at > now() - interval '1 minute' AS recent FROM core.payment_attempt WHERE id = $1",
        [attempt.attemptId],
      );
      expect(rows[0]?.recent).toBe(true);
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
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
        await commitError(pool, rawAs(buyer), (c) =>
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
        await codeOf(
          pay(pool, { authSessionId: buyer.authSessionId, sessionId, attemptId, idempotencyKey: key() }),
        ),
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
        // refused at the statement (0019) or, failing that, at commit (0016)
        /available_units (must equal|may change only to)/,
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
        /used (must equal|may change only to)/,
      ],
    ];
    for (const [label, sql, params, why, setup] of edits) {
      it(`${label}: no privilege for app_web or app_pay, inconsistent for a raw writer`, async () => {
        expect(await commitState(pool, web(buyer), (c) => c.query(sql, params()))).toBe("42501");
        expect(await commitState(pool, payAs(buyer), (c) => c.query(sql, params()))).toBe("42501");
        expect(
          await commitError(pool, rawAs(buyer), async (c) => {
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
      expect(await commitState(pool, payAs(buyer), issue)).toBe("42501");
      expect(await commitError(pool, rawAs(buyer), issue)).toMatch(/may become ISSUED only/);
      const restock =
        "UPDATE core.inventory_unit SET state = 'AVAILABLE', order_line_id = NULL WHERE state = 'ISSUED'";
      expect(await stateOf(pool, restock, [], payAs(buyer))).toBe("42501");
      expect(await stateOf(pool, restock, [], web(buyer))).toBe("42501");
    });
  });

  // -------------------------------------------------------------------------------- (4) seller locks
  describe("attack 4: holding a seller's rows to keep other buyers' pay() BUSY", () => {
    const LOCKS = ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"];

    async function holdThenProbe(as: Actor, lock: string): Promise<{ held: number; probe: string }> {
      const holder = await pool.connect();
      const prober = new pg.Client({ connectionString: db.url });
      await prober.connect();
      try {
        await holder.query("BEGIN");
        await become(holder, as);
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

    for (const lock of LOCKS) {
      it(`app_web cannot take a ${lock} lock on another seller's company`, async () => {
        expect(await holdThenProbe(web(buyer), lock)).toEqual({ held: 0, probe: "no error" });
      });
    }

    it("app_pay can lock none of a seller's company, product, warehouse, unit, coupon or wallet rows, in any mode, nor lock their tables", async () => {
      const targets: [string, string, string][] = [
        ["core.company", "id", s.companyId],
        ["core.product", "id", crorePiece.id],
        ["core.warehouse", "id", s.warehouseId],
        ["core.inventory_unit", "product_id", crorePiece.id],
        ["core.coupon", "id", couponId],
        ["ledger.wallet", "account_id", s.owner.ledgerAccountId],
        ["ledger.ledger_account", "id", s.owner.ledgerAccountId],
      ];
      for (const [table, col, id] of targets) {
        for (const lock of LOCKS) {
          expect(
            await stateOf(pool, `SELECT 1 FROM ${table} WHERE ${col} = $1 ${lock}`, [id], payAs(buyer)),
            `${table} ${lock}`,
          ).toBe("42501");
        }
        for (const mode of ["ROW SHARE", "ROW EXCLUSIVE", "SHARE", "EXCLUSIVE", "ACCESS EXCLUSIVE"]) {
          expect(
            await stateOf(pool, `LOCK TABLE ${table} IN ${mode} MODE`, [], payAs(buyer)),
            `${table} ${mode}`,
          ).toBe("42501");
        }
      }
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

    it("an attacker holding a transaction open after trying every lock and every command function on a seller's rows does not block a victim's pay()", async () => {
      // the attacker: no money (tombstoned), with a real session and attempt for the seller's
      // stocked product, so commit_purchase locks company, warehouse, product, unit and both
      // wallets before refusing INSUFFICIENT_FUNDS
      const attacker = await poorUser();
      const target = await product(pool, {
        seller: s,
        mode: "STANDARD_STOCKED",
        pricePaise: 5_000n * RUPEE,
        units: 3,
      });
      const other = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 700n * RUPEE });
      const co = await checkout(pool, attacker, [target], standard(s));
      const order = pricedFor([{ p: target, seller: s.companyId }]);
      const victim = await user(pool);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await become(holder, payAs(attacker));
        const attempts: Record<string, string> = {};
        const tryIt = async (label: string, sql: string, params: unknown[] = []) => {
          await holder.query("SAVEPOINT t");
          attempts[label] = await sqlState(holder.query(sql, params));
          await holder.query(
            attempts[label] === "no error" ? "RELEASE SAVEPOINT t" : "ROLLBACK TO SAVEPOINT t",
          );
        };
        for (const lock of LOCKS) {
          await tryIt(`company ${lock}`, `SELECT 1 FROM core.company WHERE id = $1 ${lock}`, [s.companyId]);
          await tryIt(`product ${lock}`, `SELECT 1 FROM core.product WHERE id = $1 ${lock}`, [target.id]);
          await tryIt(`warehouse ${lock}`, `SELECT 1 FROM core.warehouse WHERE id = $1 ${lock}`, [
            s.warehouseId,
          ]);
          await tryIt(`wallet ${lock}`, `SELECT 1 FROM ledger.wallet WHERE account_id = $1 ${lock}`, [
            s.owner.ledgerAccountId,
          ]);
        }
        await tryIt("sync wallets", "SELECT ledger.sync_wallets($1)", [[s.owner.ledgerAccountId]]);
        await tryIt("checkout_inputs", "SELECT core.checkout_inputs($1::jsonb, $2)", [
          JSON.stringify({
            productIds: [target.id, other.id],
            speedBySeller: standard(s),
            couponCode,
          }),
          key(),
        ]);
        await tryIt(
          "commit_purchase",
          "SELECT core.commit_purchase($1, $2, $3, $4, $5::jsonb) ->> 'status' AS st",
          [co.sessionId, co.attemptId, key(), randomBytes(32), JSON.stringify(order)],
        );
        await tryIt("create_payment_attempt", "SELECT core.create_payment_attempt($1, 'BALANCE', NULL)", [
          co.sessionId,
        ]);
        // every direct lock was refused; the functions ran and returned (the purchase as FAILED)
        expect(Object.entries(attempts).filter(([l, st]) => !l.includes(" ") && st !== "no error")).toEqual(
          [],
        );
        expect(Object.entries(attempts).filter(([l, st]) => l.includes(" ") && st !== "42501")).toEqual([]);
        const failed = await holder.query<{ failure_code: string }>(
          "SELECT failure_code FROM core.payment_attempt WHERE id = $1",
          [co.attemptId],
        );
        expect(failed.rows[0]?.failure_code).toBe("INSUFFICIENT_FUNDS");

        // with the attacker's transaction still open, the victim buys the very same product,
        // and another product of the same seller, without waiting
        const started = Date.now();
        const r1 = await payFor(pool, victim, await checkout(pool, victim, [target], standard(s)));
        const r2 = await payFor(pool, victim, await checkout(pool, victim, [other], standard(s)));
        expect(r1.orderGroupId).not.toBe(r2.orderGroupId);
        expect(Date.now() - started).toBeLessThan(1_500);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });

    it("residual, bounded: a SUCCEEDED purchase holds the rows it changed until the buyer's own transaction ends; a victim gets BUSY after 2 s, then succeeds", async () => {
      // A genuine purchase must lock the seller's wallet to credit it (A2: wallets equal their
      // postings at commit). The buyer's transaction can stay open after it (the idle timeout of
      // 0001 is a default the role can raise), so this is bounded by money and stock spent, by
      // the 2 s lock_timeout every command sets, and by one purchase per product per buyer.
      const holderBuyer = await user(pool);
      const a = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 400n * RUPEE });
      const b = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 400n * RUPEE });
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 400n * RUPEE });
      const co = await checkout(pool, holderBuyer, [a, seed], { ...standard(s), ...standard("SEED") });
      const order = pricedFor([
        { p: a, seller: s.companyId },
        { p: seed, seller: "SEED" },
      ]);
      const victim = await user(pool);
      const victimSeed = await checkout(pool, victim, [seed], standard("SEED"));
      const victimB = await checkout(pool, victim, [b], standard(s));
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await become(holder, payAs(holderBuyer));
        const { rows } = await holder.query<{ st: string }>(
          "SELECT core.commit_purchase($1, $2, $3, $4, $5::jsonb) ->> 'status' AS st",
          [co.sessionId, co.attemptId, key(), randomBytes(32), JSON.stringify(order)],
        );
        expect(rows[0]?.st).toBe("SUCCEEDED");
        // unlimited seed stock is only shared-locked: other buyers of it are not held up
        expect(await codeOf(payFor(pool, victim, victimSeed))).toBe("ok");
        // the seller's wallet is held: bounded by the 2 s lock timeout, retryable
        const started = Date.now();
        expect(await codeOf(payFor(pool, victim, victimB, "victim-retry"))).toBe("BUSY");
        expect(Date.now() - started).toBeLessThan(4_000);
      } finally {
        await holder.query("COMMIT");
        holder.release();
      }
      expect(await codeOf(payFor(pool, victim, victimB, "victim-retry"))).toBe("ok");
    });
  });

  // -------------------------------------------------------------------------------- reviewer's missing tests
  describe("creator entitlement", () => {
    const insertEntitlement = (who: TestUser, groupId: string) => (c: pg.PoolClient) =>
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
      expect(await commitState(pool, payAs(spender), insertEntitlement(spender, spent.orderGroupId))).toBe(
        "42501",
      );
      expect(await commitError(pool, rawAs(spender), insertEntitlement(spender, spent.orderGroupId))).toMatch(
        /sealed|created in this transaction/,
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
        await commitState(pool, rawAs(spender), insertEntitlement(spender, second.orderGroupId)),
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
      await become(c, as);
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
  const claiming = <T>(who: TestUser, company: string, fn: (c: pg.PoolClient) => Promise<T>) =>
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
      // the owner, derived from the session alone, sees all of it (control)
      const owner = await asActor(pool, web(s.owner), look);
      expect(owner).toMatchObject({ privateCoupon: 1, draft: 1, draftVersion: 1 });
      expect(owner.sellerOrders).toBeGreaterThan(0);
    });

    it("the owner creates coupons and draft products on their own company only", async () => {
      // coupons only through core.create_coupon (0020), which checks the company's owner itself
      const coupon = (company: string) =>
        `SELECT core.create_coupon('${company}', 'PERCENT', 5, 0, NULL, NULL, NULL, false)`;
      const other = await seller(pool);
      expect(await stateOf(pool, coupon(other.companyId), [], web(other.owner))).toBe("no error");
      const refused = await asActor(pool, web(s.owner), (c) =>
        c.query(coupon(other.companyId)).then(
          () => "no error",
          (e: { hint?: string }) => e.hint ?? "?",
        ),
      );
      expect(refused).toBe("FORBIDDEN");
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

    it("app_pay cannot list private coupons and neither it nor app_web can look codes up directly; the buyer's checkout finds one by exact code", async () => {
      expect(await asActor(pool, payAs(accomplice), visible)).toEqual({ private: 0, public: 1 });
      for (const as of [payAs(accomplice), web(buyer)]) {
        expect(
          await stateOf(pool, "SELECT * FROM core.find_coupon('TENOFF', $1::uuid[])", [[s.companyId]], as),
          as.role,
        ).toBe("42501");
      }
      // the buyer who types the code still gets it (control): quoted with the 10% discount
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const co = await checkout(pool, accomplice, [p], standard(s), couponCode.toLowerCase());
      expect(co.totalPaise).toBe(1_800n * RUPEE + DELIVERY.STANDARD);
    });
  });

  /** A hand-written purchase of one unlimited seed product (as commit_purchase writes it), as a raw writer. */
  async function forgeSeedPurchase(c: pg.PoolClient, who: TestUser, p: ProductFixture): Promise<void> {
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
      const outcome = await atIsolation("REPEATABLE READ", rawAs(buyer), async (c) => {
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
        expect(await atIsolation(level, rawAs(buyer), (c) => forgePurchase(c, buyer)), level).toMatch(
          /READ COMMITTED/,
        );
        expect(await atIsolation(level, {}, reversal), level).toMatch(/READ COMMITTED/);
      }
      // the same writes at READ COMMITTED commit (control)
      expect(await atIsolation("READ COMMITTED", rawAs(buyer), (c) => forgePurchase(c, buyer))).toBe(
        "no error",
      );
      expect(await atIsolation("READ COMMITTED", {}, reversal)).toBe("no error");
    });

    it("an unlimited-seed product repriced while a hand-written purchase is open: refused at commit (fresh read)", async () => {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 50n * CRORE });
      const outcome = await commitError(pool, rawAs(accomplice), async (c) => {
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
        await become(c, rawAs(accomplice));
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
      const recent = await asActor(pool, {}, async (c) => {
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
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await become(c, rawAs(poor));
        await relief(c, poor, RELIEF);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      // spend a little so the wallet is below the relief ceiling again
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      await payFor(pool, poor, await checkout(pool, poor, [seed], standard("SEED")));
      expect(await wallet(pool, poor.ledgerAccountId)).toBeLessThan(RELIEF);
      const backdated = await commitError(pool, rawAs(poor), async (c) => {
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
      const outcome = await commitError(pool, rawAs(buyer), (c) =>
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
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value, ends_at)
         VALUES ($1, 'MERCHANT', $2, core.generate_coupon_code(), true, 'PERCENT', 10, clock_timestamp() + interval '1.5 seconds')`,
        [id, s.companyId],
      );
      const outcome = await commitError(pool, rawAs(buyer), (c) =>
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
      const outcome = await commitError(pool, rawAs(member), (c) =>
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

    it("ledger.sync_wallets gives up on a held wallet after 2 s, whatever lock_timeout the caller set (here: a raw writer, which may execute it)", async () => {
      const holder = await pool.connect();
      const caller = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM ledger.wallet WHERE account_id = $1 FOR UPDATE", [
          buyer.ledgerAccountId,
        ]);
        await caller.query("BEGIN");
        await become(caller, rawAs(buyer));
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
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value, min_spend_paise) VALUES
           ($1, 'MERCHANT', $3, core.generate_coupon_code(), true, 'FLAT', $4, 0),
           ($2, 'MERCHANT', $3, core.generate_coupon_code(), true, 'PERCENT', 10, $5)`,
        [flatId, minSpendId, s.companyId, (5n * CRORE).toString(), (20n * CRORE).toString()],
      );
    });

    it("(a) each seller credit equals its seller order's net (the shortfall paid to SINK instead)", async () => {
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
          forgePurchase(c, buyer, { creditShortfall: 1_000n * RUPEE }),
        ),
      ).toMatch(/seller credit does not equal its seller order's net/);
    });

    it("(a2) the buyer's debit equals the order group's total (₹1 more than the total, paid to SINK, is refused by that rule)", async () => {
      // the journal balances and every seller order is right: only the buyer's debit is off. The
      // SINK rule would refuse it too, later; this asserts that the debit rule itself fires first
      expect(
        await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, { overcharge: RUPEE })),
      ).toMatch(/buyer debit \d+ does not equal the order total \d+/);
      // the same purchase without the overcharge commits (control)
      expect(await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer))).toBe("no error");
    });

    it("(b) a FLAT coupon gives exactly its amount (capped at ₹100 a line); never more", async () => {
      const flat = (discount: bigint) => ({ sellerDiscount: discount, coupon: { id: flatId, discount } });
      expect(await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, flat(5n * CRORE)))).toBe(
        "no error",
      );
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
          forgePurchase(c, buyer, flat(5n * CRORE + 1_000n * RUPEE)),
        ),
      ).toMatch(/not what coupon .* gives/);
    });

    it("(b) a coupon's minimum spend is checked by the database", async () => {
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
          forgePurchase(c, buyer, { sellerDiscount: CRORE, coupon: { id: minSpendId, discount: CRORE } }),
        ),
      ).toMatch(/minimum spend/);
    });

    it("(b) the redemption records the discount the lines give", async () => {
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
          forgePurchase(c, buyer, { sellerDiscount: CRORE, coupon: { id: couponId, discount: 1n } }),
        ),
      ).toMatch(/redemption records/);
    });

    it("(c) delivery fees: the buyer pays the configured fee, or the seller does when it offers free Standard", async () => {
      const on = (o: Forge) =>
        commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, { product: freeStd, ...o }));
      expect(await on({ deliverySeller: DELIVERY.STANDARD })).toBe("no error"); // merchant-funded (control)
      expect(await on({})).toMatch(/delivery fees do not follow/); // buyer charged although free
      expect(await on({ deliverySeller: DELIVERY.STANDARD / 2n })).toMatch(/delivery fees do not follow/);
      // not free: the buyer pays exactly the configured fee
      expect(
        await commitError(pool, rawAs(buyer), (c) =>
          forgePurchase(c, buyer, { deliveryBuyer: DELIVERY.STANDARD - RUPEE }),
        ),
      ).toMatch(/delivery fees do not follow/);
    });
  });

  describe("review 2, finding 8: buyer source, progression, shipment schedule and the FLAT split", () => {
    let testBuyer: TestUser;
    beforeAll(async () => {
      testBuyer = await user(pool);
      await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [
        testBuyer.userId,
      ]);
    });

    it("buyer_source is STAFF exactly for a test account", async () => {
      expect(
        await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, { buyerSource: "STAFF" })),
      ).toMatch(/buyer_source must be STAFF/);
      expect(
        await commitError(pool, rawAs(testBuyer), (c) => forgePurchase(c, testBuyer, { qualifies: false })),
      ).toMatch(/buyer_source must be STAFF/);
    });

    it("a test account's purchase does not qualify for progression", async () => {
      expect(
        await commitError(pool, rawAs(testBuyer), (c) =>
          forgePurchase(c, testBuyer, { buyerSource: "STAFF" }),
        ),
      ).toMatch(/does not qualify for progression/);
      expect(
        await commitError(pool, rawAs(testBuyer), (c) =>
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
        await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, { deliveredSkewMs: -60_000 })),
      ).toMatch(/shipment does not follow the STANDARD schedule/);
      expect(
        await commitError(pool, rawAs(buyer), (c) => forgePurchase(c, buyer, { deliveredSkewMs: 500 })),
      ).toBe("no error");
    });

    it("a FLAT coupon is split across lines exactly as the pricing function splits it", async () => {
      const a = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 3_001n * RUPEE });
      const b = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 5_003n * RUPEE });
      const amount = 1_000n * RUPEE + 7n;
      const id = uuidv7();
      await pool.query(
        `INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value)
         VALUES ($1, 'MERCHANT', $2, core.generate_coupon_code(), true, 'FLAT', $3)`,
        [id, s.companyId, amount.toString()],
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
      expect(await commitError(pool, rawAs(buyer), forge(split))).toBe("no error");
      const [x = 0n, y = 0n] = split;
      expect(await commitError(pool, rawAs(buyer), forge([x - 100n, y + 100n]))).toMatch(
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

  // ================================================================================ fourth review
  /** core.actor_id() as `role`, signed in with exactly this app.session_id value. */
  const actorWith = (role: string, sessionId: string) =>
    asActor(pool, { role, sessionId }, async (c) => {
      const { rows } = await c.query<{ a: string | null }>("SELECT core.actor_id() AS a");
      return rows[0]?.a ?? null;
    });

  /** Every user-scoped command, through the TypeScript layer, signed in with `authSessionId`. */
  async function everyCommand(authSessionId: string, target: { sessionId: string; attemptId: string }) {
    const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
    return {
      provision: await codeOf(
        provisionAccount(pool, { ...provisionInput(), authSessionId }).then((r) => r.userId),
      ),
      checkout: await codeOf(
        createCheckoutSession(pool, {
          authSessionId,
          lines: [{ productId: seed.id }],
          speedBySeller: standard("SEED"),
          idempotencyKey: key(),
        }),
      ),
      attempt: await codeOf(
        createPaymentAttempt(pool, { authSessionId, sessionId: target.sessionId, method: "BALANCE" }),
      ),
      authenticate: await codeOf(
        verifyCardPin(pool, { authSessionId, attemptId: target.attemptId, pinMac: TEST_PIN_MAC }),
      ),
      pay: await codeOf(
        pay(pool, {
          authSessionId,
          sessionId: target.sessionId,
          attemptId: target.attemptId,
          idempotencyKey: key(),
        }),
      ),
    };
  }
  const ALL_FORBIDDEN = {
    provision: "FORBIDDEN",
    checkout: "FORBIDDEN",
    attempt: "FORBIDDEN",
    authenticate: "FORBIDDEN",
    pay: "FORBIDDEN",
  };
  const USER_FUNCTIONS: [string, unknown[]][] = [
    [
      "core.provision_account($1, $2, ARRAY['0000000000000001'], 'a', 'a@delulu')",
      [randomBytes(32), randomBytes(32)],
    ],
    ["core.checkout_inputs($1::jsonb, 'k')", ['{"productIds":[]}']],
    ["core.create_checkout_session($1::jsonb, 'k')", ['{"productIds":[]}']],
    ["core.create_payment_attempt($1, 'BALANCE', NULL)", [uuidv7()]],
    ["core.verify_card_pin($1, $2)", [uuidv7(), Buffer.alloc(32)]],
    ["core.commit_purchase($1, $2, 'k', '\\x00', NULL)", [uuidv7(), uuidv7()]],
  ];

  describe("identity: the actor comes from the sign-in session (auth.sessions), never from a setting", () => {
    let victimCheckout: { sessionId: string; attemptId: string };
    beforeAll(async () => {
      const victim = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      victimCheckout = await checkout(pool, victim, [seed], standard("SEED"));
    });

    it("a random or guessed app.session_id yields no actor, and every user-scoped command refuses (FORBIDDEN)", async () => {
      for (const guess of [uuidv7(), buyer.userId, buyer.ledgerAccountId, "not-a-uuid", ""]) {
        expect(await actorWith("app_pay", guess), guess).toBeNull();
        expect(await actorWith("app_web", guess), guess).toBeNull();
      }
      expect(await actorWith("app_pay", buyer.authSessionId)).toBe(buyer.userId); // control
      expect(await everyCommand(uuidv7(), victimCheckout)).toEqual(ALL_FORBIDDEN);
      for (const [fn, params] of USER_FUNCTIONS) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, params, { role: "app_pay", sessionId: uuidv7() }),
          fn,
        ).toBe("DM001");
      }
    });

    it("an expired session (not_after in the past) has no actor; one expiring later still works", async () => {
      const u = await user(pool);
      const expired = uuidv7();
      const later = uuidv7();
      await pool.query(
        `INSERT INTO auth.sessions (id, user_id, not_after) VALUES ($1, $3, now() - interval '1 minute'),
                                                                  ($2, $3, now() + interval '1 hour')`,
        [expired, later, u.userId],
      );
      expect(await actorWith("app_pay", expired)).toBeNull();
      expect(await actorWith("app_pay", later)).toBe(u.userId);
      expect(await everyCommand(expired, victimCheckout)).toEqual(ALL_FORBIDDEN);
    });

    it("a banned or deleted user has no actor, whatever session they hold", async () => {
      const u = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const own = await checkout(pool, u, [seed], standard("SEED"));
      await pool.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [
        u.userId,
      ]);
      expect(await actorWith("app_pay", u.authSessionId)).toBeNull();
      expect(await everyCommand(u.authSessionId, own)).toEqual(ALL_FORBIDDEN);
      await pool.query("UPDATE auth.users SET banned_until = now() - interval '1 day' WHERE id = $1", [
        u.userId,
      ]);
      expect(await actorWith("app_pay", u.authSessionId)).toBe(u.userId); // the ban is over
      await pool.query("UPDATE auth.users SET deleted_at = now() WHERE id = $1", [u.userId]);
      expect(await actorWith("app_pay", u.authSessionId)).toBeNull();
      expect(await codeOf(payFor(pool, u, own))).toBe("FORBIDDEN");
    });

    it("setting the old app.user_id has no effect anywhere, and no policy or function reads it", async () => {
      const named = async (role: string, fn: (c: pg.PoolClient) => Promise<unknown>) =>
        asActor(pool, {}, async (c) => {
          await c.query("SELECT set_config('app.user_id', $1, true)", [buyer.userId]);
          await c.query(`SET LOCAL ROLE ${role}`);
          return fn(c);
        });
      for (const role of ["app_web", "app_pay"]) {
        const seen = await named(role, async (c) => ({
          actor: (await c.query<{ a: string | null }>("SELECT core.actor_id() AS a")).rows[0]?.a ?? null,
          profile: await countRows(c, "SELECT count(*) AS n FROM core.user_profile"),
          wallet: await countRows(c, "SELECT count(*) AS n FROM ledger.wallet"),
        }));
        expect(seen, role).toEqual({ actor: null, profile: 0, wallet: 0 });
      }
      expect(
        await named("app_pay", (c) =>
          sqlState(
            c.query("SELECT core.create_payment_attempt($1, 'BALANCE', NULL)", [victimCheckout.sessionId]),
          ),
        ),
      ).toBe("DM001");
      const { rows } = await pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM pg_policies
                  WHERE COALESCE(qual, '') || COALESCE(with_check, '') ~ 'app_user_id|app\\.user_id')
              + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname IN ('core', 'ledger', 'private', 'audit', 'analytics', 'sandbox')
                    AND (p.proname = 'app_user_id' OR p.prosrc ~ 'app\\.user_id')) AS n`,
      );
      expect(rows[0]?.n).toBe("0");
      // @ts-expect-error userId was removed: the database derives the actor from the session
      const options: TransactionOptions = { userId: buyer.userId };
      expect(options).toBeDefined();
    });

    it("no application role can read (or even reach) auth.sessions or auth.users", async () => {
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        for (const t of ["auth.sessions", "auth.users"]) {
          expect(await stateOf(pool, `SELECT 1 FROM ${t}`, [], { role }), `${role} ${t}`).toBe("42501");
        }
      }
      const { rows } = await pool.query<{ r: string }>(
        `SELECT r FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro']) r
          WHERE has_schema_privilege(r, 'auth', 'USAGE')`,
      );
      expect(rows).toEqual([]);
    });

    it("a profile cannot exist for a user id with no auth.users row (foreign key), whoever writes it", async () => {
      const invented = uuidv7();
      const insert = "INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)";
      expect(await stateOf(pool, insert, [invented, randomBytes(32)])).toBe("23503");
      expect(await stateOf(pool, insert, [invented, randomBytes(32)], { role: RAW_WRITER })).toBe("23503");
      const { rows } = await pool.query<{ ref: string }>(
        `SELECT confrelid::regclass::text AS ref FROM pg_constraint
          WHERE conrelid = 'core.user_profile'::regclass AND contype = 'f'`,
      );
      expect(rows.map((r) => r.ref)).toContain("auth.users");
    });

    it("app_pay acting with user A's session cannot spend user B's wallet by any argument", async () => {
      const a = await user(pool);
      const b = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 300n * RUPEE });
      const coB = await checkout(pool, b, [seed], standard("SEED"));
      const before = await wallet(pool, b.ledgerAccountId);
      // every command, with A's session and B's ids
      expect(
        await codeOf(
          createPaymentAttempt(pool, {
            authSessionId: a.authSessionId,
            sessionId: coB.sessionId,
            method: "BALANCE",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          verifyCardPin(pool, {
            authSessionId: a.authSessionId,
            attemptId: coB.attemptId,
            pinMac: TEST_PIN_MAC,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: a.authSessionId,
            sessionId: coB.sessionId,
            attemptId: coB.attemptId,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("NOT_FOUND");
      // raw function calls with a priced order for B's cart, as app_pay with A's session
      const order = pricedFor([{ p: seed, seller: "SEED" }]);
      const direct = await asActor(pool, payAs(a), async (c) => {
        const { rows } = await c.query<{ r: { status: string; error?: { code: string } } }>(
          "SELECT core.commit_purchase($1, $2, $3, $4, $5::jsonb) AS r",
          [coB.sessionId, coB.attemptId, key(), randomBytes(32), JSON.stringify(order)],
        );
        return rows[0]?.r;
      });
      expect(direct).toMatchObject({ status: "FAILED", error: { code: "NOT_FOUND" } });
      // B is untouched: wallet, attempt and session as they were, and B can still pay
      expect(await wallet(pool, b.ledgerAccountId)).toBe(before);
      const { rows } = await pool.query<{ a: string; s: string }>(
        `SELECT a.state AS a, s.state AS s FROM core.payment_attempt a JOIN core.checkout_session s ON s.id = a.session_id
          WHERE a.id = $1`,
        [coB.attemptId],
      );
      expect(rows[0]).toEqual({ a: "PENDING", s: "OPEN" });
      expect((await payFor(pool, b, coB)).totalPaise).toBe(300n * RUPEE + DELIVERY.STANDARD);
    });

    it("app_jobs cannot run the user-scoped commands, and acts as no user even with a valid session id", async () => {
      for (const [fn, params] of USER_FUNCTIONS) {
        expect(
          await stateOf(pool, `SELECT ${fn}`, params, { role: "app_jobs", userId: buyer.userId }),
          fn,
        ).toBe("42501");
      }
      // its raw journal debiting the buyer, with the buyer's session set, is refused: no actor
      const steal = (c: pg.PoolClient) =>
        journal(c, "PURCHASE", [
          [buyer.ledgerAccountId, -CRORE],
          [SINK_ACCOUNT_ID, CRORE],
        ]);
      expect(await commitState(pool, { role: "app_jobs", userId: buyer.userId }, steal)).toBe("42501");
      // even granted the writes (a grant mistake, rolled back with the test), it acts as no user
      const granted = await asActor(pool, {}, async (c) => {
        await c.query("GRANT INSERT ON ledger.journal, ledger.posting TO app_jobs");
        await c.query("GRANT EXECUTE ON FUNCTION ledger.sync_wallets(uuid[]) TO app_jobs");
        await become(c, { role: "app_jobs", userId: buyer.userId });
        try {
          await steal(c);
          await c.query("SET CONSTRAINTS ALL IMMEDIATE");
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      });
      expect(granted).toMatch(/acting user's own account/);
      // the same journal for the owner signed in as the buyer reaches the next rule (control)
      expect(await commitError(pool, { userId: buyer.userId }, steal)).toMatch(/order group/);
      for (const role of ["app_jobs", "npc_worker", "research_ro"]) {
        expect(await stateOf(pool, "SELECT core.actor_id()", [], { role, userId: buyer.userId }), role).toBe(
          "42501",
        );
      }
    });

    // formerly it.todo("requires auth integration"): the three gaps are now closed
    it("auth integration (1): app_pay cannot choose the acting user; naming one does nothing, a session decides", async () => {
      const victim = await user(pool);
      const chosen = await asActor(pool, { role: "app_pay" }, async (c) => {
        await c.query("SELECT set_config('app.user_id', $1, true)", [victim.userId]);
        await c.query("SELECT set_config('app.session_id', $1, true)", [victim.userId]);
        return (await c.query<{ a: string | null }>("SELECT core.actor_id() AS a")).rows[0]?.a ?? null;
      });
      expect(chosen).toBeNull();
    });

    it("auth integration (2): with the app_pay credential and no victim session, an attacker cannot spend another user's wallet", async () => {
      const victim = await user(pool);
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const co = await checkout(pool, victim, [seed], standard("SEED"));
      const before = await wallet(pool, victim.ledgerAccountId);
      for (const guess of [victim.userId, uuidv7(), co.sessionId, co.attemptId]) {
        expect(
          await codeOf(
            pay(pool, {
              authSessionId: guess,
              sessionId: co.sessionId,
              attemptId: co.attemptId,
              idempotencyKey: key(),
            }),
          ),
          guess,
        ).toBe("FORBIDDEN");
      }
      expect(await wallet(pool, victim.ledgerAccountId)).toBe(before);
    });

    it("auth integration (3): app_pay cannot provision an invented user (no session for it; the profile's id references auth.users)", async () => {
      const invented = uuidv7();
      expect(
        await codeOf(
          provisionAccount(pool, { ...provisionInput({ userId: invented }), authSessionId: invented }),
        ),
      ).toBe("FORBIDDEN");
      expect(await count(pool, "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", [invented])).toBe(
        0,
      );
    });
  });

  // -------------------------------------------------------------------------------- no raw money writes
  describe("privileges: no raw money writes or row locks for app_web or app_pay", () => {
    const MONEY_TABLES = [
      "ledger.ledger_account",
      "ledger.journal",
      "ledger.posting",
      "ledger.wallet",
      "ledger.grant_record",
      "ledger.journal_seal",
      "core.user_profile",
      "core.bank_account",
      "core.virtual_card",
      "core.checkout_session",
      "core.payment_attempt",
      "core.payment_challenge",
      "core.idempotency_record",
      "core.order_group",
      "core.order_group_seal",
      "core.seller_order",
      "core.order_line",
      "core.ownership",
      "core.shipment",
      "core.coupon_redemption",
      "core.coupon_lookup_failure",
      "core.creator_entitlement",
      "core.inventory_unit",
    ];
    const COUNTERS: [string, string][] = [
      ["core.product", "available_units"],
      ["core.coupon", "redeemed"],
      ["core.warehouse", "used"],
      ["core.promo_campaign", "spent_paise"],
    ];
    const STATEMENTS = (t: string, col: string) => [
      `INSERT INTO ${t} DEFAULT VALUES`,
      `UPDATE ${t} AS x SET ${col} = x.${col} WHERE false`,
      `DELETE FROM ${t} WHERE false`,
      `SELECT 1 FROM ${t} FOR UPDATE`,
      `SELECT 1 FROM ${t} FOR NO KEY UPDATE`,
      `SELECT 1 FROM ${t} FOR SHARE`,
      `SELECT 1 FROM ${t} FOR KEY SHARE`,
    ];

    it("the list covers every ledger table", async () => {
      const { rows } = await pool.query<{ t: string }>(
        `SELECT c.oid::regclass::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'ledger' AND c.relkind IN ('r','p') ORDER BY 1`,
      );
      expect(rows.map((r) => r.t).filter((t) => !MONEY_TABLES.includes(t))).toEqual([]);
    });

    for (const role of ["app_web", "app_pay"]) {
      for (const t of MONEY_TABLES) {
        it(`${role}: INSERT, UPDATE, DELETE and every row lock on ${t} are denied`, async () => {
          const { rows } = await pool.query<{ col: string }>(
            `SELECT attname AS col FROM pg_attribute
              WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attidentity = '' AND attgenerated = ''
              ORDER BY attnum LIMIT 1`,
            [t],
          );
          const col = rows[0]?.col ?? "id";
          for (const sql of STATEMENTS(t, col)) {
            expect(await stateOf(pool, sql, [], { role, userId: buyer.userId }), sql).toBe("42501");
          }
          const held = await pool.query<{ p: string }>(
            `SELECT p FROM unnest(ARRAY['INSERT','UPDATE']) p WHERE has_any_column_privilege($1, $2, p)
             UNION ALL SELECT p FROM unnest(ARRAY['DELETE','TRUNCATE']) p WHERE has_table_privilege($1, $2, p)`,
            [role, t],
          );
          expect(held.rows).toEqual([]);
        });
      }
      it(`${role}: no write on the stock, coupon and budget counters; app_pay locks no product, company or warehouse`, async () => {
        for (const [t, col] of COUNTERS) {
          expect(
            await stateOf(pool, `UPDATE ${t} AS x SET ${col} = x.${col} WHERE false`, [], {
              role,
              userId: buyer.userId,
            }),
            `${t}.${col}`,
          ).toBe("42501");
          const { rows } = await pool.query<{ has: boolean }>(
            "SELECT has_column_privilege($1, $2, $3, 'UPDATE') OR has_column_privilege($1, $2, $3, 'INSERT') AS has",
            [role, t, col],
          );
          expect(rows[0]?.has, `${t}.${col}`).toBe(false);
        }
        if (role === "app_pay") {
          for (const t of [
            "core.product",
            "core.company",
            "core.warehouse",
            "core.coupon",
            "core.promo_campaign",
          ]) {
            for (const lock of ["FOR UPDATE", "FOR SHARE", "FOR KEY SHARE"]) {
              expect(
                await stateOf(pool, `SELECT 1 FROM ${t} ${lock}`, [], payAs(buyer)),
                `${t} ${lock}`,
              ).toBe("42501");
            }
          }
        }
      });
      it(`${role}: cannot execute ledger.sync_wallets or core.find_coupon`, async () => {
        const { rows } = await pool.query<{ f: string }>(
          `SELECT f FROM unnest(ARRAY['ledger.sync_wallets(uuid[])', 'core.find_coupon(text,uuid[])']) f
            WHERE has_function_privilege($1, f, 'EXECUTE')`,
          [role],
        );
        expect(rows).toEqual([]);
      });
    }
  });

  // -------------------------------------------------------------------------------- seals
  describe("the deferred checks are re-check-proof: seals (0016 R9)", () => {
    // a buyer of this block's own: its genuine purchases stay within the per-actor payment
    // attempt limit (10 a minute, 0018) whatever the rest of the file did in the last minute
    let buyer: TestUser;
    beforeAll(async () => {
      buyer = await user(pool);
    });

    /** A genuine purchase through core.commit_purchase as app_pay, in the caller's transaction. */
    async function genuinePurchase(
      c: pg.PoolClient,
      who: TestUser,
    ): Promise<{ journalId: string; sellerOrderId: string }> {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const co = await checkout(pool, who, [seed], standard("SEED"));
      await become(c, payAs(who));
      const { rows } = await c.query<{ st: string }>(
        "SELECT core.commit_purchase($1, $2, $3, $4, $5::jsonb) ->> 'status' AS st",
        [
          co.sessionId,
          co.attemptId,
          key(),
          randomBytes(32),
          JSON.stringify(pricedFor([{ p: seed, seller: "SEED" }])),
        ],
      );
      expect(rows[0]?.st).toBe("SUCCEEDED");
      const ids = await c.query<{ j: string; so: string }>(
        `SELECT g.journal_id AS j, so.id AS so FROM core.order_group g JOIN core.seller_order so ON so.order_group_id = g.id
          WHERE g.session_id = $1`,
        [co.sessionId],
      );
      const row = ids.rows[0];
      if (!row) throw new Error("fixture: purchase not visible to its buyer");
      return { journalId: row.j, sellerOrderId: row.so };
    }

    /** Runs fn in one transaction as given and returns the first error message, or "committed". */
    async function inOneTx(fn: (c: pg.PoolClient) => Promise<unknown>): Promise<string> {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await fn(c);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        return "committed";
      } catch (error) {
        return (error as Error).message;
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }

    const mintToBuyer = async (c: pg.PoolClient, journalId: string) => {
      await c.query(
        "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x'), ($1, $4, $5, 'x')",
        [
          journalId,
          MINT_ACCOUNT_ID,
          (-50_000n * CRORE).toString(),
          buyer.ledgerAccountId,
          (50_000n * CRORE).toString(),
        ],
      );
      await c.query("SELECT ledger.sync_wallets($1)", [[buyer.ledgerAccountId]]);
    };

    it("exploit 1 replayed: genuine ₹100 purchase, SET CONSTRAINTS IMMEDIATE/DEFERRED, then MINT −5,000 crore → buyer on the same journal: refused (app_jobs and a raw writer)", async () => {
      for (const writer of ["app_jobs", RAW_WRITER]) {
        const outcome = await inOneTx(async (c) => {
          const { journalId } = await genuinePurchase(c, buyer);
          await c.query(`SET LOCAL ROLE ${writer}`);
          await c.query("SET CONSTRAINTS ALL IMMEDIATE");
          await c.query("SET CONSTRAINTS ALL DEFERRED");
          await mintToBuyer(c, journalId);
        });
        // the job runner writes no posting at all (fourth review); a raw writer meets the seal
        expect(outcome, writer).toMatch(
          writer === "app_jobs"
            ? /permission denied/
            : /posting row refused: its journal has already been checked and sealed/,
        );
      }
      // the same with a hand-written purchase by a raw writer that fires the checks itself
      const outcome = await inOneTx(async (c) => {
        await become(c, rawAs(buyer));
        await forgePurchase(c, buyer);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        await c.query("SET CONSTRAINTS ALL DEFERRED");
        const { rows } = await c.query<{ id: string }>(
          "SELECT id FROM ledger.journal WHERE created_txid = txid_current() AND event_type = 'PURCHASE'",
        );
        await mintToBuyer(c, rows[0]?.id ?? "");
      });
      expect(outcome).toMatch(/sealed/);
    });

    it("exploit 2 replayed: then an extra order line and ownership of a ₹100 crore product for ₹1 in the same order: refused", async () => {
      const huge = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * CRORE });
      const outcome = await inOneTx(async (c) => {
        const { sellerOrderId } = await genuinePurchase(c, buyer);
        await c.query(`SET LOCAL ROLE ${RAW_WRITER}`);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        await c.query("SET CONSTRAINTS ALL DEFERRED");
        const line = uuidv7();
        await c.query(
          `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
             seller_discount_paise, platform_discount_paise, fee_paise, line_no)
           VALUES ($1, $2, $3, $4, '{}', 100, 0, 0, 0, 1)`,
          [line, sellerOrderId, huge.id, huge.versionId],
        );
      });
      expect(outcome).toMatch(/order_line row refused: its order group has already been checked and sealed/);
      // ... and ownership of it on the purchase's own (sealed) line
      const owned = await inOneTx(async (c) => {
        const { sellerOrderId } = await genuinePurchase(c, buyer);
        await c.query(`SET LOCAL ROLE ${RAW_WRITER}`);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        await c.query("SET CONSTRAINTS ALL DEFERRED");
        await c.query(
          `INSERT INTO core.ownership (id, user_id, product_id, order_line_id)
           SELECT $1, $2, $3, l.id FROM core.order_line l WHERE l.seller_order_id = $4`,
          [uuidv7(), accomplice.userId, huge.id, sellerOrderId],
        );
      });
      expect(owned).toMatch(/ownership row refused: its order group has already been checked and sealed/);
    });

    it("every child of a sealed journal or order group is refused; later lifecycle updates by the job runner are not", async () => {
      const results = await (async () => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const { journalId, sellerOrderId } = await genuinePurchase(c, buyer);
          await c.query(`SET LOCAL ROLE ${RAW_WRITER}`);
          const out: Record<string, string> = {};
          const tryIt = async (label: string, sql: string, params: unknown[]) => {
            await c.query("SAVEPOINT x");
            out[label] = await c.query(sql, params).then(
              () => "accepted",
              (e: Error) => (/sealed/.test(e.message) ? "sealed" : e.message),
            );
            await c.query("ROLLBACK TO SAVEPOINT x");
          };
          const { rows } = await c.query<{ id: string; g: string }>(
            "SELECT l.id, so.order_group_id AS g FROM core.order_line l JOIN core.seller_order so ON so.id = l.seller_order_id WHERE so.id = $1",
            [sellerOrderId],
          );
          const line = rows[0]?.id;
          const group = rows[0]?.g;
          await tryIt(
            "grant_record",
            "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day) VALUES ($1, $2, $3, 'RELIEF', 100000000, (now() AT TIME ZONE 'UTC')::date)",
            [uuidv7(), buyer.userId, journalId],
          );
          await tryIt(
            "ownership",
            "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
            [uuidv7(), accomplice.userId, crorePiece.id, line],
          );
          await tryIt(
            "seller_order",
            "INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise) VALUES ($1, $2, $3, NULL, 'SEED', 100, 0, 100)",
            [uuidv7(), group, buyer.userId],
          );
          await tryIt(
            "shipment",
            "INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at) VALUES ($1, $2, 'ZAP', now(), now(), now(), now(), now())",
            [uuidv7(), sellerOrderId],
          );
          await tryIt(
            "coupon_redemption",
            "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, 0)",
            [couponId, accomplice.userId, group],
          );
          await tryIt("order_line amount", "UPDATE core.order_line SET list_paise = 1 WHERE id = $1", [line]);
          await tryIt("seller_order amount", "UPDATE core.seller_order SET net_paise = 0 WHERE id = $1", [
            sellerOrderId,
          ]);
          await tryIt("order_group total", "UPDATE core.order_group SET total_paise = 1 WHERE id = $1", [
            group,
          ]);
          await tryIt(
            "unit issue",
            "UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = $2 WHERE id = (SELECT id FROM core.inventory_unit WHERE product_id = $1 AND state = 'AVAILABLE' LIMIT 1)",
            [crorePiece.id, line],
          );
          await tryIt(
            "entitlement evidence",
            "INSERT INTO core.creator_entitlement (id, user_id, source, evidence_order_group_id) VALUES ($1, $2, 'PURCHASE_THRESHOLD', $3)",
            [uuidv7(), accomplice.userId, group],
          );
          // lifecycle columns the job runner moves later
          await tryIt(
            "seller_order status",
            "UPDATE core.seller_order SET status = 'REVERSED', qualifies_for_progression = false WHERE id = $1",
            [sellerOrderId],
          );
          await tryIt(
            "ownership state",
            "UPDATE core.ownership SET state = 'REVOKED' WHERE order_line_id = $1",
            [line],
          );
          await tryIt(
            "shipment notified",
            "UPDATE core.shipment SET delivered_notified = true, cancelled_at = now() WHERE seller_order_id = $1",
            [sellerOrderId],
          );
          return out;
        } finally {
          await c.query("ROLLBACK").catch(() => undefined);
          c.release();
        }
      })();
      expect(results).toEqual({
        grant_record: "sealed",
        ownership: "sealed",
        seller_order: "sealed",
        shipment: "sealed",
        coupon_redemption: "sealed",
        "order_line amount": "sealed",
        "seller_order amount": "sealed",
        "order_group total": "sealed",
        "unit issue": "sealed",
        "entitlement evidence": "sealed",
        "seller_order status": "accepted",
        "ownership state": "accepted",
        "shipment notified": "accepted",
      });
    });
  });

  // -------------------------------------------------------------------------------- tombstones
  describe("the fingerprint-planting tombstone bypass is impossible", () => {
    it("a deleted user who signs up again cannot plant a profile with a chosen fingerprint, and gets no second starter grant", async () => {
      const email = randomBytes(32);
      const first = await provisionAccount(pool, provisionInput({ emailFingerprint: email }));
      expect(first.walletPaise).toBe(100n * CRORE);
      // account deletion (job runner): tombstone the fingerprint, retire the auth user
      await pool.query(
        "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '1 year')",
        [email],
      );
      await pool.query("UPDATE core.user_profile SET email_fingerprint = $2 WHERE id = $1", [
        first.userId,
        randomBytes(32),
      ]);
      await pool.query("UPDATE auth.users SET deleted_at = now() WHERE id = $1", [first.userId]);
      // the same person signs up again: a new auth user and session
      const again = provisionInput({ emailFingerprint: email });
      const authSessionId = await sessionFor(pool, again.userId);
      const plant =
        "INSERT INTO core.user_profile (id, email_fingerprint, phone_fingerprint) VALUES ($1, $2, NULL)";
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(
          await stateOf(pool, plant, [again.userId, randomBytes(32)], { role, sessionId: authSessionId }),
          role,
        ).toBe("42501");
      }
      const second = await provisionAccount(pool, { ...again, authSessionId });
      expect(second).toMatchObject({ created: true, walletPaise: 0n, starterJournalId: null });
      // a later call with a fresh fingerprint changes nothing
      const third = await provisionAccount(pool, {
        ...again,
        emailFingerprint: randomBytes(32),
        authSessionId,
      });
      expect(third).toMatchObject({ created: false, walletPaise: 0n, starterJournalId: null });
      const stored = await pool.query<{ fp: Buffer }>(
        "SELECT email_fingerprint AS fp FROM core.user_profile WHERE id = $1",
        [again.userId],
      );
      expect(stored.rows[0]?.fp.equals(email)).toBe(true);
    });

    it("even a profile planted with a clean fingerprint by a writer the grants missed gets no grant when the fingerprint presented is tombstoned", async () => {
      const email = randomBytes(32);
      await pool.query(
        "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '1 year')",
        [email],
      );
      const input = provisionInput({ emailFingerprint: email });
      const authSessionId = await sessionFor(pool, input.userId);
      await pool.query("INSERT INTO core.user_profile (id, email_fingerprint) VALUES ($1, $2)", [
        input.userId,
        randomBytes(32),
      ]);
      const r = await provisionAccount(pool, { ...input, authSessionId });
      expect(r).toMatchObject({ created: true, walletPaise: 0n, grantRecordId: null });
    });
  });

  // -------------------------------------------------------------------------------- coupon brute force
  describe("coupon codes cannot be brute-forced", () => {
    it("lookups are limited to the cart's sellers, and after 10 failed lookups in an hour every code is COUPON_INVALID for that user", async () => {
      const guesser = await user(pool);
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 2_000n * RUPEE });
      const other = await seller(pool);
      const elsewhere = await product(pool, {
        seller: other,
        mode: "STANDARD_STOCKED",
        pricePaise: 2_000n * RUPEE,
      });
      const attempt = (code: string, prod = p, sellerOf: Seller = s) =>
        codeOf(
          createCheckoutSession(pool, {
            authSessionId: guesser.authSessionId,
            lines: [{ productId: prod.id }],
            speedBySeller: standard(sellerOf),
            couponCode: code,
            idempotencyKey: key(),
          }),
        );
      // s's real code, tried on another seller's cart: not found (and counted)
      expect(await attempt(couponCode, elsewhere, other)).toBe("COUPON_INVALID");
      for (let i = 0; i < 9; i++) expect(await attempt(`GUESS${i}`)).toBe("COUPON_INVALID");
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.coupon_lookup_failure WHERE user_id = $1", [
          guesser.userId,
        ]),
      ).toBe(10);
      // the right code now answers exactly like a wrong one
      expect(await attempt(couponCode)).toBe("COUPON_INVALID");
      // other users are unaffected; the limit is per user, per hour
      expect(await codeOf(checkout(pool, accomplice, [p], standard(s), couponCode))).toBe("ok");
      await pool.query(
        "UPDATE core.coupon_lookup_failure SET at = at - interval '2 hours' WHERE user_id = $1",
        [guesser.userId],
      );
      expect(await attempt(couponCode)).toBe("ok");
    });
  });

  // -------------------------------------------------------------------------------- idempotency limits
  describe("idempotency keys are bounded", () => {
    it("a key is at most 200 characters, in the table and in the command functions", async () => {
      const long = "k".repeat(201);
      expect(
        await stateOf(
          pool,
          "INSERT INTO core.idempotency_record (user_id, command, key, request_hash) VALUES ($1, 'pay', $2, '\\x00')",
          [buyer.userId, long],
        ),
      ).toBe("23514");
      expect(
        await stateOf(
          pool,
          "SELECT core.commit_purchase($1, $2, $3, '\\x00', NULL)",
          [uuidv7(), uuidv7(), long],
          payAs(buyer),
        ),
      ).toBe("DM001");
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: buyer.authSessionId,
            sessionId: uuidv7(),
            attemptId: uuidv7(),
            idempotencyKey: long,
          }),
        ),
      ).toBe("VALIDATION_FAILED");
    });

    it("at most 1,000 live records per user; records older than 24 h are purged by the job runner's function", async () => {
      const busy = await user(pool);
      await pool.query(
        `INSERT INTO core.idempotency_record (user_id, command, key, request_hash, created_at)
         SELECT $1, 'checkout.create', 'old-' || g, '\\x00', now() - interval '1 hour' FROM generate_series(1, 1000) g`,
        [busy.userId],
      );
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const quote = () => codeOf(checkout(pool, busy, [seed], standard("SEED")));
      expect(await quote()).toBe("RATE_LIMITED");
      for (const role of ["app_web", "app_pay"]) {
        expect(await stateOf(pool, "SELECT core.purge_idempotency_records()", [], { role }), role).toBe(
          "42501",
        );
      }
      await pool.query(
        "UPDATE core.idempotency_record SET created_at = now() - interval '25 hours' WHERE user_id = $1",
        [busy.userId],
      );
      const purged = await withTransaction(
        pool,
        async (c) => {
          const { rows } = await c.query<{ n: string }>("SELECT core.purge_idempotency_records()::text AS n");
          return Number(rows[0]?.n);
        },
        { role: "app_jobs" },
      );
      expect(purged).toBeGreaterThanOrEqual(1000);
      expect(await quote()).toBe("ok");
    });

    it("a stored success whose order was later reversed is replayed with a reversed marker", async () => {
      const seed = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100n * RUPEE });
      const co = await checkout(pool, accomplice, [seed], standard("SEED"));
      const k = key();
      const first = await payFor(pool, accomplice, co, k);
      expect(first.reversed).toBe(false);
      expect((await payFor(pool, accomplice, co, k)).reversed).toBe(false);
      // the order is marked reversed (a lifecycle column the seal allows); until the reversal
      // feature brings an owner-run function for the job runner, only the owner can do this
      await withTransaction(pool, (c) =>
        c.query(
          "UPDATE core.seller_order SET status = 'REVERSED', qualifies_for_progression = false WHERE order_group_id = $1",
          [first.orderGroupId],
        ),
      );
      const replay = await payFor(pool, accomplice, co, k);
      expect(replay).toEqual({ ...first, reversed: true });
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
      // the read-only questions RLS policies ask, the coupon commands of 0020 and the profile
      // command of 0023 (no money moves), and the actor-scoped and catalog reads of 0026
      expect(fns.rows.map((r) => r.f)).toEqual([
        "core.actor_id()",
        "core.catalog_product(uuid)",
        "core.catalog_products(text,uuid,integer)",
        "core.create_coupon(uuid,text,bigint,bigint,timestamp with time zone,timestamp with time zone,integer,boolean,text)",
        "core.is_published_version(uuid)",
        "core.my_collection()",
        "core.my_order(uuid)",
        "core.my_orders(uuid,integer)",
        "core.my_statement(bigint,integer)",
        "core.my_wallet()",
        "core.owns_products(uuid[])",
        "core.page_size(integer)",
        "core.reveal_card_number(uuid)",
        "core.set_coupon_status(uuid,text)",
        "core.update_profile(text,jsonb,boolean)",
      ]);
    });

    it("every SECURITY DEFINER function and who may execute it: app_pay runs only the command functions", async () => {
      const { rows } = await pool.query<{ role: string; f: string }>(
        `SELECT r AS role, p.oid::regprocedure::text AS f
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r
          WHERE n.nspname IN ('core','ledger','private','audit','analytics','sandbox','research','ops') AND p.prosecdef
            AND has_function_privilege(r, p.oid, 'EXECUTE')
          ORDER BY 1, 2`,
      );
      const by = (role: string) => rows.filter((r) => r.role === role).map((r) => r.f);
      expect(by("app_pay")).toEqual([
        "core.actor_id()",
        "core.checkout_inputs(jsonb,text)",
        "core.commit_purchase(uuid,uuid,text,bytea,jsonb)",
        "core.create_checkout_session(jsonb,text)",
        "core.create_payment_attempt(uuid,text,uuid)",
        "core.is_published_version(uuid)",
        "core.my_wallet()",
        "core.onboarding_status()",
        "core.owns_products(uuid[])",
        "core.provision_account(bytea,bytea,text[],text,text)",
        "core.record_birthdate(bytea,boolean)",
        "core.record_phone_verified(bytea,bytea)",
        "core.reset_card_pin(uuid,bytea)",
        "core.set_card_frozen(uuid,boolean)",
        "core.set_card_pin(uuid,bytea,bytea)",
        "core.verify_card_pin(uuid,bytea)",
      ]);
      expect(by("app_jobs")).toEqual([
        "core.identity_is_tombstoned(bytea,bytea)",
        "core.is_published_version(uuid)",
        "core.purge_idempotency_records()",
        "ops.terminate_stuck_money_sessions(interval)",
      ]);
      expect(by("npc_worker")).toEqual(["core.is_published_version(uuid)"]);
      expect([...by("research_ro"), ...by("anon"), ...by("authenticated")]).toEqual([]);
      // every definer function pins its search_path
      const unpinned = await pool.query<{ f: string }>(
        `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('core','ledger','ops') AND p.prosecdef
            AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, pg_temp')`,
      );
      expect(unpinned.rows).toEqual([]);
    });
  });
});
