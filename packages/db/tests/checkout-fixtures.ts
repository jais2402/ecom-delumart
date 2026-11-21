import { randomBytes } from "node:crypto";
import type pg from "pg";
import { setCardPin, verifyCardPin } from "../src/card";
import {
  createCheckoutSession,
  createPaymentAttempt,
  type PayReceipt,
  pay,
  type SellerQuote,
} from "../src/checkout";
import { inTx, provisionAccount, provisionInput, type TestUser, uuidv7 } from "./helpers";

/** A test PIN's HMAC (the database only ever sees the 32-byte mac, never a PIN). */
export const TEST_PIN_MAC = Buffer.alloc(32, 7);

/** Sets the user's card PIN to TEST_PIN_MAC when it has none, then passes the attempt's PIN step. */
export async function authenticateCard(pool: pg.Pool, buyer: TestUser, attemptId: string): Promise<void> {
  const { rows } = await pool.query<{ set: boolean }>(
    "SELECT pin_hash IS NOT NULL AS set FROM core.virtual_card WHERE id = $1",
    [buyer.cardId],
  );
  if (!rows[0]?.set) {
    await setCardPin(pool, {
      authSessionId: buyer.authSessionId,
      cardId: buyer.cardId,
      pinMac: TEST_PIN_MAC,
    });
  }
  await verifyCardPin(pool, { authSessionId: buyer.authSessionId, attemptId, pinMac: TEST_PIN_MAC });
}

export const RUPEE = 100n;
export const LAKH = 100_000n * RUPEE;
export const CRORE = 10_000_000n * RUPEE;
/** Standard delivery from the default pricing configuration: ₹1,000. */
export const STANDARD_DELIVERY = 1_000n * RUPEE;

export const user = (pool: pg.Pool): Promise<TestUser> => provisionAccount(pool, provisionInput());

export interface Seller {
  owner: TestUser;
  companyId: string;
  warehouseId: string;
}

/** A provisioned owner with a company and its starter warehouse (written as the owner/migrator). */
export async function seller(pool: pg.Pool): Promise<Seller> {
  const owner = await user(pool);
  const companyId = uuidv7();
  const warehouseId = uuidv7();
  await pool.query("INSERT INTO core.company (id, owner_user_id, name) VALUES ($1, $2, $3)", [
    companyId,
    owner.userId,
    `Shop ${randomBytes(3).toString("hex")}`,
  ]);
  await pool.query(
    "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'STARTER', 100, 0)",
    [warehouseId, companyId],
  );
  return { owner, companyId, warehouseId };
}

export type Mode = "STANDARD_STOCKED" | "EXCLUSIVE" | "UNLIMITED_SEED";

export interface ProductFixture {
  id: string;
  versionId: string;
  pricePaise: bigint;
}

/**
 * A PUBLISHED product with a current version; stocked modes get `units` AVAILABLE units.
 * Written in one transaction: product.available_units and warehouse.used must equal the
 * AVAILABLE units at commit (migration 0016).
 */
export async function product(
  pool: pg.Pool,
  opts: {
    seller?: Seller;
    mode: Mode;
    pricePaise: bigint;
    units?: number;
    freeStd?: boolean;
    express?: boolean;
    zap?: boolean;
    warehouseId?: string;
  },
): Promise<ProductFixture> {
  return inTx(pool, (c) => productIn(c, opts));
}

async function productIn(
  pool: pg.PoolClient,
  opts: {
    seller?: Seller;
    mode: Mode;
    pricePaise: bigint;
    units?: number;
    freeStd?: boolean;
    express?: boolean;
    zap?: boolean;
    warehouseId?: string;
  },
): Promise<ProductFixture> {
  const id = uuidv7();
  const versionId = uuidv7();
  const units = opts.mode === "UNLIMITED_SEED" ? 0 : (opts.units ?? 1);
  const seed = opts.mode === "UNLIMITED_SEED";
  await pool.query(
    `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, exclusive_supply,
                               available_units, free_standard_delivery, offers_express, zap_flag, published_at)
     VALUES ($1, $2, $3, 'PUBLISHED', 'gadgets', $4, $5, $6, $7, $8, $9, now())`,
    [
      id,
      seed ? null : (opts.seller?.companyId ?? null),
      seed ? "SEED" : "USER",
      opts.mode,
      opts.mode === "EXCLUSIVE" ? units : null,
      units,
      opts.freeStd ?? false,
      opts.express ?? false,
      opts.zap ?? false,
    ],
  );
  await pool.query(
    `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
     VALUES ($1, $2, 1, 'Moon Lamp', 'A lamp that is mostly moon.', 'A round lamp', 1, $3)`,
    [versionId, id, opts.pricePaise.toString()],
  );
  await pool.query("UPDATE core.product SET current_version_id = $2 WHERE id = $1", [id, versionId]);
  if (units > 0) {
    if (!opts.seller) throw new Error("stocked products need a seller");
    for (let serial = 1; serial <= units; serial++) {
      await pool.query(
        `INSERT INTO core.inventory_unit (id, product_id, warehouse_id, serial, state)
         VALUES ($1, $2, $3, $4, 'AVAILABLE')`,
        [uuidv7(), id, opts.warehouseId ?? opts.seller.warehouseId, serial],
      );
    }
    await pool.query("UPDATE core.warehouse SET used = used + $2 WHERE id = $1", [
      opts.warehouseId ?? opts.seller.warehouseId,
      units,
    ]);
  }
  return { id, versionId, pricePaise: opts.pricePaise };
}

/** Publishes a new current version at a new price (as the seller would). */
export async function reprice(pool: pg.Pool, p: ProductFixture, pricePaise: bigint): Promise<void> {
  const versionId = uuidv7();
  await pool.query(
    `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
     VALUES ($1, $2, (SELECT max(revision) + 1 FROM core.product_version WHERE product_id = $2),
             'Moon Lamp', 'A lamp that is mostly moon.', 'A round lamp', 1, $3)`,
    [versionId, p.id, pricePaise.toString()],
  );
  await pool.query("UPDATE core.product SET current_version_id = $2 WHERE id = $1", [p.id, versionId]);
}

/**
 * An ACTIVE merchant PERCENT coupon of the seller's company (written as the owner). A private
 * coupon's code is generated, never chosen (migration 0020): the code is returned for the buyer
 * to type. `publicCode` makes a public coupon with that code instead.
 */
export async function merchantCoupon(
  pool: pg.Pool,
  s: Seller,
  opts: { percent: number; maxRedemptions?: number; publicCode?: string },
): Promise<{ id: string; code: string }> {
  const id = uuidv7();
  const { rows } = await pool.query<{ code: string }>(
    `INSERT INTO core.coupon (id, scope, company_id, code_normalised, code_generated, kind, value, max_redemptions, is_public)
     VALUES ($1, 'MERCHANT', $2, COALESCE($3::text, core.generate_coupon_code()), $3::text IS NULL, 'PERCENT', $4, $5,
             $3::text IS NOT NULL)
     RETURNING code_normalised AS code`,
    [id, s.companyId, opts.publicCode ?? null, opts.percent, opts.maxRedemptions ?? null],
  );
  const code = rows[0]?.code;
  if (!code) throw new Error("fixture: coupon not created");
  return { id, code };
}

export const key = (): string => `k-${uuidv7()}`;

/** Speeds for the given sellers: STANDARD for each company id and for SEED. */
export function standard(...sellers: (Seller | "SEED")[]): Record<string, "STANDARD"> {
  return Object.fromEntries(sellers.map((s) => [s === "SEED" ? "SEED" : s.companyId, "STANDARD" as const]));
}

export interface Checkout {
  sessionId: string;
  attemptId: string;
  totalPaise: bigint;
  sellers: SellerQuote[];
}

/** Quote + BALANCE attempt (authenticated immediately). */
export async function checkout(
  pool: pg.Pool,
  buyer: TestUser,
  products: ProductFixture[],
  speeds: Record<string, "STANDARD" | "EXPRESS" | "ZAP">,
  couponCode?: string,
): Promise<Checkout> {
  const session = await createCheckoutSession(pool, {
    authSessionId: buyer.authSessionId,
    lines: products.map((p) => ({ productId: p.id })),
    speedBySeller: speeds,
    ...(couponCode ? { couponCode } : {}),
    idempotencyKey: key(),
  });
  const attempt = await createPaymentAttempt(pool, {
    authSessionId: buyer.authSessionId,
    sessionId: session.sessionId,
    method: "BALANCE",
  });
  return {
    sessionId: session.sessionId,
    attemptId: attempt.attemptId,
    totalPaise: session.totalPaise,
    sellers: session.sellers,
  };
}

export function payFor(pool: pg.Pool, buyer: TestUser, co: Checkout, k = key()): Promise<PayReceipt> {
  return pay(pool, {
    authSessionId: buyer.authSessionId,
    sessionId: co.sessionId,
    attemptId: co.attemptId,
    idempotencyKey: k,
  });
}

/** The error code a rejected promise carries (DomainError code or SQLSTATE), or "ok". */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : `unexpected: ${(error as Error).message}`;
  }
}

export async function wallet(pool: pg.Pool, account: string): Promise<bigint> {
  const { rows } = await pool.query<{ p: string }>(
    "SELECT available_paise::text AS p FROM ledger.wallet WHERE account_id = $1",
    [account],
  );
  return BigInt(rows[0]?.p ?? "-1");
}

export async function sinkBalance(pool: pg.Pool): Promise<bigint> {
  const { rows } = await pool.query<{ s: string }>(
    "SELECT COALESCE(SUM(amount), 0)::text AS s FROM ledger.posting WHERE account_id = '00000000-0000-7000-8000-000000000002'",
  );
  return BigInt(rows[0]?.s ?? "0");
}

/** Postings of the order group's journal, keyed by account id. */
export async function journalPostings(pool: pg.Pool, orderGroupId: string): Promise<Map<string, bigint>> {
  const { rows } = await pool.query<{ account_id: string; amount: string }>(
    `SELECT p.account_id, SUM(p.amount)::text AS amount
       FROM ledger.posting p JOIN core.order_group g ON g.journal_id = p.journal_id
      WHERE g.id = $1 GROUP BY p.account_id`,
    [orderGroupId],
  );
  return new Map(rows.map((r) => [r.account_id, BigInt(r.amount)]));
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n);
}

/** LLD §5.9 reconciliation queries 1–4; every list must be empty and the total zero. */
export async function reconcile(pool: pg.Pool): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  const total = await pool.query<{ s: string }>(
    "SELECT COALESCE(SUM(amount), 0)::text AS s FROM ledger.posting",
  );
  return {
    unbalancedJournals: await q(
      "SELECT journal_id FROM ledger.posting GROUP BY journal_id HAVING SUM(amount) <> 0",
    ),
    walletMismatch: await q(
      `SELECT w.account_id FROM ledger.wallet w
         LEFT JOIN (SELECT account_id, SUM(amount) s FROM ledger.posting GROUP BY account_id) p USING (account_id)
        WHERE w.available_paise <> COALESCE(p.s, 0)`,
    ),
    globalSum: total.rows[0]?.s,
    productStock: await q(
      `SELECT p.id FROM core.product p
        WHERE p.inventory_mode <> 'UNLIMITED_SEED'
          AND p.available_units <> (SELECT count(*) FROM core.inventory_unit u WHERE u.product_id = p.id AND u.state = 'AVAILABLE')`,
    ),
    warehouseUsed: await q(
      `SELECT w.id FROM core.warehouse w
        WHERE w.used <> (SELECT count(*) FROM core.inventory_unit u WHERE u.warehouse_id = w.id AND u.state = 'AVAILABLE')`,
    ),
    succeededWithoutOneOrder: await q(
      `SELECT a.id FROM core.payment_attempt a
        WHERE a.state = 'SUCCEEDED'
          AND (SELECT count(*) FROM core.order_group g WHERE g.payment_attempt_id = a.id) <> 1`,
    ),
  };
}

export const CLEAN = {
  unbalancedJournals: [],
  walletMismatch: [],
  globalSum: "0",
  productStock: [],
  warehouseUsed: [],
  succeededWithoutOneOrder: [],
};
