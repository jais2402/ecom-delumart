/**
 * Checkout and pay (LLD §5.2, §5.3, lock order §4). Every command is a call to an owner-run
 * SECURITY DEFINER function of migration 0018, made as the money-command role app_pay with the
 * caller's sign-in session id; the database derives the acting user from that session, takes
 * the locks, writes, and runs every structural money check before the call returns. app_pay
 * itself holds no write privilege on any money, order, payment or stock table.
 *
 * Every amount comes from `price()` in @delulu/core: this module prices the cart from rows it
 * can read and hands the result to the database, which re-derives each amount in SQL from the
 * rows it has locked and refuses anything that differs. Nothing here computes money beyond
 * serialising what `price()` returned.
 */
import { createHash } from "node:crypto";
import {
  type Coupon,
  DEFAULT_PRICING_CONFIG,
  DomainError,
  type ErrorCode,
  type Priced,
  type PricingConfig,
  price,
  SEED_SELLER,
  type Speed,
} from "@delulu/core";
import type { Pool, PoolClient } from "pg";
import { asPay, domainErrorOf, isUuid, requireUuid } from "./command";

// ---------------------------------------------------------------------------- public types

export type PaymentMethod = "BALANCE" | "CARD";

export interface CreateCheckoutSessionInput {
  /** The caller's sign-in session (auth.sessions id). */
  authSessionId: string;
  lines: readonly { productId: string }[];
  /** Delivery speed per seller order: the company id, or "SEED" for platform seed stock. */
  speedBySeller: Readonly<Record<string, Speed>>;
  couponCode?: string;
  addressId?: string;
  idempotencyKey: string;
}

export interface SellerQuote {
  sellerId: string;
  speed: Speed;
  listPaise: bigint;
  sellerDiscountPaise: bigint;
  platformDiscountPaise: bigint;
  feePaise: bigint;
  deliveryFeeBuyerPaise: bigint;
  deliveryFeeSellerPaise: bigint;
  netPaise: bigint;
  /** What the buyer pays for this seller order. */
  buyerPaise: bigint;
}

export interface CheckoutSessionResult {
  sessionId: string;
  expiresAt: Date;
  configVersion: number;
  totalPaise: bigint;
  sellers: SellerQuote[];
}

export interface CreatePaymentAttemptInput {
  authSessionId: string;
  /** The checkout session. */
  sessionId: string;
  method: PaymentMethod;
  cardId?: string;
}

export interface PaymentAttemptResult {
  attemptId: string;
  reference: string;
  method: PaymentMethod;
  authenticated: boolean;
}

export interface PayInput {
  authSessionId: string;
  /** The checkout session. */
  sessionId: string;
  attemptId: string;
  idempotencyKey: string;
}

export interface PayReceipt {
  orderGroupId: string;
  paymentReference: string;
  sellers: { sellerId: string; sellerOrderId: string; totalPaise: bigint }[];
  totalPaise: bigint;
  balanceAfterPaise: bigint;
  creatorUnlocked: boolean;
  /** Set on a replay when the order has since been reversed (its seller orders REVERSED). */
  reversed: boolean;
}

/**
 * A terminal validation failure of pay: the attempt is recorded FAILED with this code
 * and the failure is stored under the idempotency key. `replayed` is set when the
 * failure is returned from the idempotency record rather than freshly detected.
 */
export class PayFailure extends DomainError {
  readonly replayed: boolean;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, replayed = false) {
    super(code, message, details);
    this.name = "PayFailure";
    this.replayed = replayed;
  }
}

// ---------------------------------------------------------------------------- configuration

interface CheckoutConfig {
  pricing: PricingConfig;
}

const SPEEDS: readonly Speed[] = ["STANDARD", "EXPRESS", "ZAP"];

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function paiseValue(v: unknown, fallback: bigint): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return fallback;
}

function intValue(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return fallback;
}

/** Pricing configuration from config_version values, defaults otherwise (as core.config_* read them). */
function parseConfig(values: unknown): CheckoutConfig {
  const v = asRecord(values) ?? {};
  const fees = asRecord(v.delivery_fee_paise) ?? {};
  const fee = (s: Speed) => paiseValue(fees[s], DEFAULT_PRICING_CONFIG.deliveryFeePaise[s]);
  return {
    pricing: {
      deliveryFeePaise: { STANDARD: fee("STANDARD"), EXPRESS: fee("EXPRESS"), ZAP: fee("ZAP") },
      feePercent: intValue(v.fee_percent, DEFAULT_PRICING_CONFIG.feePercent),
      couponPercentMin: intValue(v.coupon_percent_min, DEFAULT_PRICING_CONFIG.couponPercentMin),
      couponPercentMax: intValue(v.coupon_percent_max, DEFAULT_PRICING_CONFIG.couponPercentMax),
    },
  };
}

async function loadConfig(c: PoolClient, id: number): Promise<CheckoutConfig | null> {
  const { rows } = await c.query<{ values: unknown }>(
    "SELECT values FROM core.config_version WHERE id = $1",
    [id],
  );
  return rows[0] ? parseConfig(rows[0].values) : null;
}

// ---------------------------------------------------------------------------- pricing

interface PricingLine {
  productId: string;
  sellerId: string;
  listPaise: bigint;
  freeStdDelivery: boolean;
}

export interface CouponTerms {
  /** Set by core.resolve_cart (the coupon's id and normalised code); not read by pricing. */
  id?: string;
  code?: string;
  companyId: string;
  kind: "PERCENT" | "FLAT";
  value: string;
  minSpendPaise: string;
}

function couponOf(c: CouponTerms | null): Coupon | undefined {
  if (!c) return undefined;
  const minSpend = BigInt(c.minSpendPaise);
  return {
    scope: "MERCHANT",
    companyId: c.companyId,
    discount:
      c.kind === "PERCENT"
        ? { kind: "PERCENT", percent: Number(c.value) }
        : { kind: "FLAT", amountPaise: BigInt(c.value) },
    ...(minSpend > 0n ? { minSpendPaise: minSpend } : {}),
  };
}

function priceLines(
  lines: readonly PricingLine[],
  coupon: CouponTerms | null,
  speedBySeller: Readonly<Record<string, Speed>>,
  isMember: boolean,
  cfg: CheckoutConfig,
): Priced {
  const c = couponOf(coupon);
  return price({
    lines: lines.map((l) => ({ ...l })),
    ...(c ? { coupon: c } : {}),
    speedBySeller: new Map(Object.entries(speedBySeller)),
    isMember,
    cfg: cfg.pricing,
  });
}

/**
 * The pricing function's result as the database re-derives it (core.price_cart, migration
 * 0018): money as decimal strings, lines in input order, sellers in first-appearance order.
 */
function serialisePriced(p: Priced): unknown {
  return {
    lines: p.lines.map((l) => ({
      productId: l.productId,
      sellerId: l.sellerId,
      listPaise: l.listPaise.toString(),
      sellerDisc: l.sellerDisc.toString(),
      platformDisc: l.platformDisc.toString(),
      fee: l.fee.toString(),
    })),
    sellers: p.perSeller.map((s) => ({
      sellerId: s.sellerId,
      speed: s.speed,
      list: s.list.toString(),
      sellerDisc: s.sellerDisc.toString(),
      platformDisc: s.platformDisc.toString(),
      fee: s.fee.toString(),
      deliveryBuyer: s.deliveryBuyer.toString(),
      deliverySeller: s.deliverySeller.toString(),
      net: s.net.toString(),
    })),
    postings: p.postings.map((x) => ({ account: x.account, amount: x.amountPaise.toString() })),
    total: p.buyerTotal.toString(),
  };
}

// ---------------------------------------------------------------------------- helpers

function requireKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) {
    throw new DomainError("VALIDATION_FAILED", "idempotency key must be 1–200 characters");
  }
}

function requestHash(command: string, body: unknown): Buffer {
  return createHash("sha256")
    .update(`${command}\n${JSON.stringify(body)}`)
    .digest();
}

export type Refusal = { code?: unknown; message?: unknown };
export type Outcome<T> = { ok: T } | { refused: Refusal };

/**
 * The one pricing path of a product checkout: the resolved cart (core.resolve_cart) priced by
 * price() with the configuration version it names. createCheckoutSession and the cart preview
 * (cart.ts) both call this, so a preview and the checkout session made from the same inputs
 * cannot disagree. A refusal price() raises (a coupon below its minimum spend, ...) is returned.
 */
export async function priceInputs(c: PoolClient, inputs: CartInputs): Promise<Outcome<Priced>> {
  const cfg = await loadConfig(c, inputs.configVersion);
  if (!cfg) return { refused: { code: "MAINTENANCE", message: "no effective configuration version" } };
  try {
    return {
      ok: priceLines(
        inputs.lines.map((l) => ({ ...l, listPaise: BigInt(l.listPaise) })),
        inputs.coupon,
        inputs.speedBySeller,
        inputs.isMember,
        cfg,
      ),
    };
  } catch (error) {
    if (error instanceof DomainError) return { refused: { code: error.code, message: error.message } };
    throw error;
  }
}

// ---------------------------------------------------------------------------- B1: checkout session

interface StoredSeller {
  sellerId: string;
  speed: Speed;
  listPaise: string;
  sellerDiscountPaise: string;
  platformDiscountPaise: string;
  feePaise: string;
  deliveryFeeBuyerPaise: string;
  deliveryFeeSellerPaise: string;
  netPaise: string;
  buyerPaise: string;
}

interface StoredSession {
  sessionId: string;
  expiresAt: string;
  quote: { configVersion: number; totalPaise: string; sellers: StoredSeller[] };
}

/** What core.resolve_cart returns for a cart (migration 0018): everything price() needs. */
export interface CartInputs {
  configVersion: number;
  isMember: boolean;
  lines: { productId: string; sellerId: string; listPaise: string; freeStdDelivery: boolean }[];
  speedBySeller: Record<string, Speed>;
  coupon: CouponTerms | null;
}

function sessionResult(s: StoredSession): CheckoutSessionResult {
  return {
    sessionId: s.sessionId,
    expiresAt: new Date(s.expiresAt),
    configVersion: s.quote.configVersion,
    totalPaise: BigInt(s.quote.totalPaise),
    sellers: s.quote.sellers.map((x) => ({
      sellerId: x.sellerId,
      speed: x.speed,
      listPaise: BigInt(x.listPaise),
      sellerDiscountPaise: BigInt(x.sellerDiscountPaise),
      platformDiscountPaise: BigInt(x.platformDiscountPaise),
      feePaise: BigInt(x.feePaise),
      deliveryFeeBuyerPaise: BigInt(x.deliveryFeeBuyerPaise),
      deliveryFeeSellerPaise: BigInt(x.deliveryFeeSellerPaise),
      netPaise: BigInt(x.netPaise),
      buyerPaise: BigInt(x.buyerPaise),
    })),
  };
}

/**
 * LLD §8.4: validates the cart and stores an immutable, priced quote valid for five minutes.
 * Two calls in one transaction: core.checkout_inputs resolves the cart (and a coupon code, by
 * exact code among this cart's sellers, failures counted per user), price() prices it, and
 * core.create_checkout_session re-derives every amount in SQL before storing the session.
 * Refusals are returned from the transaction and thrown after it commits, so a failed coupon
 * lookup is counted.
 */
export async function createCheckoutSession(
  pool: Pool,
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  requireKey(input.idempotencyKey);
  const productIds = input.lines.map((l) => l.productId);
  for (const id of productIds) requireUuid(id, "productId");
  if (new Set(productIds).size !== productIds.length) {
    throw new DomainError("VALIDATION_FAILED", "each product appears once (quantity one)");
  }
  if (input.addressId !== undefined) requireUuid(input.addressId, "addressId");
  for (const [seller, speed] of Object.entries(input.speedBySeller)) {
    if (!SPEEDS.includes(speed))
      throw new DomainError("VALIDATION_FAILED", "unknown delivery speed", { seller });
  }
  const choices = {
    productIds,
    speedBySeller: input.speedBySeller,
    couponCode: input.couponCode ?? null,
    addressId: input.addressId ?? null,
  };

  const outcome = await asPay<Outcome<StoredSession>>(pool, input.authSessionId, async (c) => {
    const step1 = await c.query<{ r: { replay?: StoredSession; error?: Refusal; inputs?: CartInputs } }>(
      "SELECT core.checkout_inputs($1::jsonb, $2) AS r",
      [JSON.stringify(choices), input.idempotencyKey],
    );
    const r1 = step1.rows[0]?.r;
    if (r1?.replay) return { ok: r1.replay };
    if (!r1?.inputs) return { refused: r1?.error ?? {} };
    const pricing = await priceInputs(c, r1.inputs);
    if ("refused" in pricing) return pricing;
    const priced = pricing.ok;
    const step2 = await c.query<{ r: { replay?: StoredSession; error?: Refusal; result?: StoredSession } }>(
      "SELECT core.create_checkout_session($1::jsonb, $2) AS r",
      [JSON.stringify({ ...choices, priced: serialisePriced(priced) }), input.idempotencyKey],
    );
    const r2 = step2.rows[0]?.r;
    const stored = r2?.result ?? r2?.replay;
    return stored ? { ok: stored } : { refused: r2?.error ?? {} };
  });
  if ("refused" in outcome) throw domainErrorOf(outcome.refused);
  return sessionResult(outcome.ok);
}

// ---------------------------------------------------------------------------- B2: payment attempt

/** Creates a PENDING attempt; BALANCE is authenticated immediately, CARD after its PIN is verified. */
export async function createPaymentAttempt(
  pool: Pool,
  input: CreatePaymentAttemptInput,
): Promise<PaymentAttemptResult> {
  requireUuid(input.sessionId, "sessionId");
  if (input.method !== "BALANCE" && input.method !== "CARD") {
    throw new DomainError("VALIDATION_FAILED", "unsupported payment method");
  }
  if (input.method === "CARD") requireUuid(input.cardId ?? "", "cardId");
  else if (input.cardId !== undefined) {
    throw new DomainError("VALIDATION_FAILED", "a card is only given for CARD payments");
  }
  return asPay(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ r: PaymentAttemptResult }>(
      "SELECT core.create_payment_attempt($1, $2, $3) AS r",
      [input.sessionId, input.method, input.cardId ?? null],
    );
    const r = rows[0]?.r;
    if (!r) throw new Error("create_payment_attempt returned nothing");
    return r;
  });
}

// ---------------------------------------------------------------------------- B3: pay

interface StoredReceipt {
  orderGroupId: string;
  paymentReference: string;
  sellers: { sellerId: string; sellerOrderId: string; totalPaise: string }[];
  totalPaise: string;
  balanceAfterPaise: string;
  creatorUnlocked: boolean;
}

type PayOutcome =
  | { status: "SUCCEEDED"; receipt: StoredReceipt; replayed: boolean; reversed: boolean }
  | { status: "FAILED"; error: Refusal; replayed: boolean };

function receiptOf(r: StoredReceipt, reversed: boolean): PayReceipt {
  return {
    orderGroupId: r.orderGroupId,
    paymentReference: r.paymentReference,
    sellers: r.sellers.map((s) => ({
      sellerId: s.sellerId,
      sellerOrderId: s.sellerOrderId,
      totalPaise: BigInt(s.totalPaise),
    })),
    totalPaise: BigInt(r.totalPaise),
    balanceAfterPaise: BigInt(r.balanceAfterPaise),
    creatorUnlocked: r.creatorUnlocked,
    reversed,
  };
}

const PAY = "pay";

/**
 * Prices the stored session's choices from the rows app_pay can read (current product versions,
 * the coupon named in the buyer's own session, membership, the session's configuration). Returns
 * null when something needed is not readable (a hidden product, a paused coupon, ...): the
 * database then refuses with the right code from its locked rows, or asks for a retry.
 */
async function priceForPay(c: PoolClient, sessionId: string): Promise<unknown> {
  const s = await c.query<{ quote: unknown; config_version: number }>(
    "SELECT quote, config_version FROM core.checkout_session WHERE id = $1",
    [sessionId],
  );
  const session = s.rows[0];
  const q = asRecord(session?.quote);
  if (!session || !q || !Array.isArray(q.lines)) return null;
  const productIds = q.lines.map((l) => asRecord(l)?.productId);
  if (productIds.length === 0 || !productIds.every(isUuid)) return null;
  const speeds = asRecord(q.speedBySeller);
  if (!speeds) return null;
  const cfg = await loadConfig(c, session.config_version);
  if (!cfg) return null;

  const { rows: products } = await c.query<{
    id: string;
    company_id: string | null;
    free_standard_delivery: boolean;
    price_paise: string;
  }>(
    `SELECT p.id, p.company_id, p.free_standard_delivery, v.price_paise::text AS price_paise
       FROM core.product p JOIN core.product_version v ON v.id = p.current_version_id
      WHERE p.id = ANY($1::uuid[]) AND p.status = 'PUBLISHED'`,
    [productIds],
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: PricingLine[] = [];
  for (const id of productIds) {
    const p = byId.get(id);
    if (!p) return null;
    lines.push({
      productId: p.id,
      sellerId: p.company_id ?? SEED_SELLER,
      listPaise: BigInt(p.price_paise),
      freeStdDelivery: p.free_standard_delivery,
    });
  }

  let coupon: CouponTerms | null = null;
  const couponId = asRecord(q.coupon)?.id;
  if (couponId !== undefined) {
    if (!isUuid(couponId)) return null;
    const { rows } = await c.query<CouponTerms>(
      `SELECT company_id AS "companyId", kind, value::text AS value, min_spend_paise::text AS "minSpendPaise"
         FROM core.coupon WHERE id = $1`,
      [couponId],
    );
    if (!rows[0]) return null;
    coupon = rows[0];
  }
  const member = await c.query(
    "SELECT 1 FROM core.membership WHERE starts_at <= clock_timestamp() AND ends_at > clock_timestamp()",
  );
  const speedBySeller: Record<string, Speed> = {};
  for (const [seller, speed] of Object.entries(speeds)) {
    if (SPEEDS.includes(speed as Speed)) speedBySeller[seller] = speed as Speed;
  }
  try {
    return serialisePriced(priceLines(lines, coupon, speedBySeller, (member.rowCount ?? 0) > 0, cfg));
  } catch (error) {
    if (error instanceof DomainError) return null; // the database refuses with the same code
    throw error;
  }
}

/** The unique violation of core.ownership (user_id, product_id): a concurrent purchase won. */
function isOwnershipRace(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && e.constraint === "ownership_user_id_product_id_key";
}

/**
 * LLD §5.2 pay transaction, through core.commit_purchase. Idempotent per (user, key); one
 * success per session. A validation failure leaves no business rows: the database records
 * the attempt FAILED and stores the failure under the key, and this throws PayFailure.
 */
export async function pay(pool: Pool, input: PayInput): Promise<PayReceipt> {
  requireKey(input.idempotencyKey);
  requireUuid(input.sessionId, "sessionId");
  requireUuid(input.attemptId, "attemptId");
  const hash = requestHash(PAY, { sessionId: input.sessionId, attemptId: input.attemptId });
  const purchase = asPay(pool, input.authSessionId, async (c) => {
    const order = await priceForPay(c, input.sessionId);
    const { rows } = await c.query<{ r: PayOutcome }>(
      "SELECT core.commit_purchase($1, $2, $3, $4, $5::jsonb) AS r",
      [
        input.sessionId,
        input.attemptId,
        input.idempotencyKey,
        hash,
        order === null ? null : JSON.stringify(order),
      ],
    );
    const r = rows[0]?.r;
    if (!r) throw new Error("commit_purchase returned nothing");
    return r;
  });
  let outcome: PayOutcome;
  try {
    outcome = await purchase;
  } catch (error) {
    // Two pays of one buyer (different keys, different sessions) for the same product can both pass
    // the ownership check before either commits; the loser then meets the one-owner-per-product
    // unique index. That is the same refusal as the check (fifth security review), not a fault.
    if (isOwnershipRace(error)) throw new PayFailure("ALREADY_OWNED", "you already own this product");
    throw error;
  }
  if (outcome.status === "SUCCEEDED") return receiptOf(outcome.receipt, outcome.reversed);
  const failure = domainErrorOf(outcome.error);
  throw new PayFailure(failure.code, failure.message, {}, outcome.replayed);
}
