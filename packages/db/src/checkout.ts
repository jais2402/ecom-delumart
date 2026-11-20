/**
 * Checkout and pay (LLD §5.2, §5.3, lock order §4). Every command runs as the
 * money-command role app_pay (never app_web, which holds no write privilege on money,
 * orders or stock) inside one transaction with app.user_id set, so row-level security
 * applies. Every amount comes from `price()` in @delulu/core; nothing here computes
 * money beyond summing what `price()` returned. pay() trusts nothing in the stored quote
 * but the buyer's choices (products, speed per seller, coupon, address): prices,
 * versions, coupon terms, delivery eligibility and fees are rebuilt from locked rows.
 * The database re-checks the result at commit (migration 0016).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type Coupon,
  CREATOR_THRESHOLD_PAISE,
  computeShipmentSchedule,
  DEFAULT_DELIVERY_DURATIONS_MS,
  DEFAULT_PRICING_CONFIG,
  type DeliveryDurationsMs,
  DomainError,
  type ErrorCode,
  type Priced,
  type PricingConfig,
  price,
  SEED_SELLER,
  type Speed,
  shouldUnlockCreator,
} from "@delulu/core";
import type { Pool, PoolClient } from "pg";
import { MINT_ACCOUNT_ID, SINK_ACCOUNT_ID } from "./provision";
import { withTransaction } from "./transaction";
import { uuidv7 } from "./uuid";

// ---------------------------------------------------------------------------- public types

export type PaymentMethod = "BALANCE" | "CARD";

export interface CreateCheckoutSessionInput {
  userId: string;
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
  userId: string;
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
  userId: string;
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
  durations: DeliveryDurationsMs;
  creatorThresholdPaise: bigint;
  sessionTtlSeconds: number;
  maxLines: number;
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

/** config_version values where present, the documented defaults otherwise. */
function parseConfig(values: unknown): CheckoutConfig {
  const v = asRecord(values) ?? {};
  const fees = asRecord(v.delivery_fee_paise) ?? {};
  const durations = asRecord(v.delivery_duration_ms) ?? {};
  const fee = (s: Speed) => paiseValue(fees[s], DEFAULT_PRICING_CONFIG.deliveryFeePaise[s]);
  const dur = (s: Speed) => intValue(durations[s], DEFAULT_DELIVERY_DURATIONS_MS[s]);
  return {
    pricing: {
      deliveryFeePaise: { STANDARD: fee("STANDARD"), EXPRESS: fee("EXPRESS"), ZAP: fee("ZAP") },
      feePercent: intValue(v.fee_percent, DEFAULT_PRICING_CONFIG.feePercent),
      couponPercentMin: intValue(v.coupon_percent_min, DEFAULT_PRICING_CONFIG.couponPercentMin),
      couponPercentMax: intValue(v.coupon_percent_max, DEFAULT_PRICING_CONFIG.couponPercentMax),
    },
    durations: { STANDARD: dur("STANDARD"), EXPRESS: dur("EXPRESS"), ZAP: dur("ZAP") },
    creatorThresholdPaise: paiseValue(v.creator_threshold_paise, CREATOR_THRESHOLD_PAISE),
    sessionTtlSeconds: intValue(v.checkout_session_ttl_seconds, 300),
    maxLines: intValue(v.cart_max_lines, 20),
  };
}

async function loadConfig(c: PoolClient, id?: number): Promise<{ id: number; cfg: CheckoutConfig }> {
  const { rows } = await c.query<{ id: number; values: unknown }>(
    id === undefined
      ? "SELECT id, values FROM core.config_version WHERE effective_from <= now() ORDER BY id DESC LIMIT 1"
      : "SELECT id, values FROM core.config_version WHERE id = $1",
    id === undefined ? [] : [id],
  );
  const row = rows[0];
  if (!row) throw new DomainError("MAINTENANCE", "no effective configuration version");
  return { id: row.id, cfg: parseConfig(row.values) };
}

// ---------------------------------------------------------------------------- stored quote

interface StoredLine {
  productId: string;
  productVersionId: string;
  sellerId: string;
  companyId: string | null;
  listPaise: string;
  freeStdDelivery: boolean;
  inventoryMode: string;
}

interface StoredCoupon {
  id: string;
  companyId: string;
  code: string;
  kind: "PERCENT" | "FLAT";
  value: string;
  minSpendPaise: string;
}

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

interface StoredQuote {
  version: 1;
  lines: StoredLine[];
  speedBySeller: Record<string, Speed>;
  coupon: StoredCoupon | null;
  isMember: boolean;
  addressId: string | null;
  configVersion: number;
  sellers: StoredSeller[];
  totalPaise: string;
}

function couponOf(c: StoredCoupon | null): Coupon | undefined {
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
  lines: readonly { productId: string; sellerId: string; listPaise: bigint; freeStdDelivery: boolean }[],
  coupon: StoredCoupon | null,
  speedBySeller: Readonly<Record<string, Speed>>,
  isMember: boolean,
  cfg: CheckoutConfig,
): Priced {
  const c = couponOf(coupon);
  return price({
    lines: lines.map((l) => ({
      productId: l.productId,
      sellerId: l.sellerId,
      listPaise: l.listPaise,
      freeStdDelivery: l.freeStdDelivery,
    })),
    ...(c ? { coupon: c } : {}),
    speedBySeller: new Map(Object.entries(speedBySeller)),
    isMember,
    cfg: cfg.pricing,
  });
}

function storedSellers(priced: Priced): StoredSeller[] {
  return priced.perSeller.map((s) => ({
    sellerId: s.sellerId,
    speed: s.speed,
    listPaise: s.list.toString(),
    sellerDiscountPaise: s.sellerDisc.toString(),
    platformDiscountPaise: s.platformDisc.toString(),
    feePaise: s.fee.toString(),
    deliveryFeeBuyerPaise: s.deliveryBuyer.toString(),
    deliveryFeeSellerPaise: s.deliverySeller.toString(),
    netPaise: s.net.toString(),
    buyerPaise: (s.list - s.sellerDisc - s.platformDisc + s.deliveryBuyer).toString(),
  }));
}

function sellerQuote(s: StoredSeller): SellerQuote {
  return {
    sellerId: s.sellerId,
    speed: s.speed,
    listPaise: BigInt(s.listPaise),
    sellerDiscountPaise: BigInt(s.sellerDiscountPaise),
    platformDiscountPaise: BigInt(s.platformDiscountPaise),
    feePaise: BigInt(s.feePaise),
    deliveryFeeBuyerPaise: BigInt(s.deliveryFeeBuyerPaise),
    deliveryFeeSellerPaise: BigInt(s.deliveryFeeSellerPaise),
    netPaise: BigInt(s.netPaise),
    buyerPaise: BigInt(s.buyerPaise),
  };
}

// ---------------------------------------------------------------------------- helpers

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a uuid`, { field });
  }
}

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

/** Lock or statement timeout surfaces as the retryable BUSY result (LLD §4). */
function busyOr(error: unknown): unknown {
  const code = (error as { code?: unknown }).code;
  if (code === "55P03" || code === "57014") {
    return new DomainError("BUSY", "the request is busy; retry with the same idempotency key");
  }
  return error;
}

/** Runs fn as app_pay with app.user_id set, under the LLD §4 timeouts. */
async function asPay<T>(pool: Pool, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  requireUuid(userId, "userId");
  try {
    return await withTransaction(pool, fn, {
      role: "app_pay",
      userId,
      lockTimeout: "2s",
      statementTimeout: "5s",
    });
  } catch (error) {
    throw busyOr(error);
  }
}

type IdemState = { completed: false } | { completed: true; status: number; response: unknown };

/** LLD §5.3: insert-or-lock the record; same key + different request is a CONFLICT. */
async function idemBegin(
  c: PoolClient,
  userId: string,
  command: string,
  key: string,
  hash: Buffer,
): Promise<IdemState> {
  await c.query(
    `INSERT INTO core.idempotency_record (user_id, command, key, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, command, key, hash],
  );
  const { rows } = await c.query<{ request_hash: Buffer; status: number | null; response: unknown }>(
    `SELECT request_hash, status, response FROM core.idempotency_record
      WHERE user_id = $1 AND command = $2 AND key = $3 FOR UPDATE`,
    [userId, command, key],
  );
  const row = rows[0];
  if (!row) throw new Error("idempotency record is not visible to this transaction");
  if (!row.request_hash.equals(hash)) {
    throw new DomainError("CONFLICT", "this idempotency key was used for a different request");
  }
  if (row.status !== null) return { completed: true, status: row.status, response: row.response };
  return { completed: false };
}

async function idemComplete(
  c: PoolClient,
  userId: string,
  command: string,
  key: string,
  status: number,
  response: unknown,
): Promise<void> {
  await c.query(
    `UPDATE core.idempotency_record SET status = $4, response = $5
      WHERE user_id = $1 AND command = $2 AND key = $3`,
    [userId, command, key, status, JSON.stringify(response)],
  );
}

/**
 * Delivery speed eligibility (LLD §5.2): Express only if every product offers it; Zap
 * only for seed items flagged for it or for units held in a Zap hub warehouse.
 */
function speedOffered(
  speed: Speed,
  sellerId: string,
  products: readonly { id: string; offers_express: boolean; zap_flag: boolean }[],
  inHub: ReadonlySet<string>,
): boolean {
  if (speed === "STANDARD") return true;
  if (speed === "EXPRESS") return products.every((p) => p.offers_express);
  return sellerId === SEED_SELLER
    ? products.every((p) => p.zap_flag)
    : products.every((p) => inHub.has(p.id));
}

function isStocked(mode: string): boolean {
  return mode === "STANDARD_STOCKED" || mode === "EXCLUSIVE";
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

interface CouponRow {
  id: string;
  scope: string;
  company_id: string;
  code_normalised: string;
  kind: "PERCENT" | "FLAT";
  value: string;
  min_spend_paise: string;
  max_redemptions: number | null;
  redeemed: number;
  status: string;
  in_window: boolean;
}

// Expiry is judged by the clock, not the transaction start (as the database does, 0016).
const COUPON_COLUMNS = `id, scope, company_id, code_normalised, kind, value::text, min_spend_paise::text,
  max_redemptions, redeemed, status,
  ((starts_at IS NULL OR starts_at <= clock_timestamp()) AND (ends_at IS NULL OR ends_at > clock_timestamp())) AS in_window`;

/** Coupon rules shared by quote and pay. Returns the error to raise, or null when usable. */
async function couponProblem(
  c: PoolClient,
  coupon: CouponRow | undefined,
  userId: string,
  owners: ReadonlyMap<string, string>,
): Promise<[ErrorCode, string] | null> {
  if (coupon?.status !== "ACTIVE" || coupon.scope !== "MERCHANT") {
    return ["COUPON_INVALID", "coupon is not active"];
  }
  if (!coupon.in_window) return ["COUPON_INVALID", "coupon is outside its validity window"];
  if (coupon.max_redemptions !== null && coupon.redeemed >= coupon.max_redemptions) {
    return ["COUPON_INVALID", "coupon has reached its redemption cap"];
  }
  if (!owners.has(coupon.company_id)) {
    return ["COUPON_NOT_APPLICABLE", "coupon belongs to no seller in the cart"];
  }
  if (owners.get(coupon.company_id) === userId) {
    return ["COUPON_NOT_APPLICABLE", "a company owner cannot redeem their own coupon"];
  }
  const used = await c.query("SELECT 1 FROM core.coupon_redemption WHERE coupon_id = $1 AND user_id = $2", [
    coupon.id,
    userId,
  ]);
  if ((used.rowCount ?? 0) > 0) return ["COUPON_NOT_APPLICABLE", "coupon already redeemed by this buyer"];
  return null;
}

async function isMember(c: PoolClient, userId: string): Promise<boolean> {
  const { rowCount } = await c.query(
    "SELECT 1 FROM core.membership WHERE user_id = $1 AND starts_at <= clock_timestamp() AND ends_at > clock_timestamp()",
    [userId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------- B1: checkout session

interface ProductRow {
  id: string;
  company_id: string | null;
  seller_type: string;
  status: string;
  current_version_id: string | null;
  inventory_mode: string;
  available_units: number;
  offers_express: boolean;
  free_standard_delivery: boolean;
  zap_flag: boolean;
  version_id: string | null;
  price_paise: string | null;
}

function sessionResult(id: string, expiresAt: string, q: StoredQuote): CheckoutSessionResult {
  return {
    sessionId: id,
    expiresAt: new Date(expiresAt),
    configVersion: q.configVersion,
    totalPaise: BigInt(q.totalPaise),
    sellers: q.sellers.map(sellerQuote),
  };
}

/** LLD §8.4: validates the cart and stores an immutable, priced quote valid for five minutes. */
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
  const hash = requestHash("checkout.create", {
    productIds,
    speeds: Object.entries(input.speedBySeller).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    coupon: input.couponCode === undefined ? null : normaliseCode(input.couponCode),
    addressId: input.addressId ?? null,
  });

  return asPay(pool, input.userId, async (c) => {
    const idem = await idemBegin(c, input.userId, "checkout.create", input.idempotencyKey, hash);
    if (idem.completed) {
      const r = idem.response as { sessionId: string; expiresAt: string; quote: StoredQuote };
      return sessionResult(r.sessionId, r.expiresAt, r.quote);
    }

    const { id: configVersion, cfg } = await loadConfig(c);
    if (productIds.length === 0 || productIds.length > cfg.maxLines) {
      throw new DomainError("VALIDATION_FAILED", `a checkout has 1–${cfg.maxLines} lines`);
    }

    const { rows: products } = await c.query<ProductRow>(
      `SELECT p.id, p.company_id, p.seller_type, p.status, p.current_version_id, p.inventory_mode,
              p.available_units, p.offers_express, p.free_standard_delivery, p.zap_flag,
              v.id AS version_id, v.price_paise::text AS price_paise
         FROM core.product p LEFT JOIN core.product_version v ON v.id = p.current_version_id
        WHERE p.id = ANY($1::uuid[])`,
      [productIds],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const id of productIds) {
      const p = byId.get(id);
      if (p?.status !== "PUBLISHED" || !p.version_id || p.price_paise === null) {
        throw new DomainError("PRODUCT_UNAVAILABLE", "a product is not available", { productId: id });
      }
      if (isStocked(p.inventory_mode) && p.available_units <= 0) {
        throw new DomainError("SOLD_OUT", "a product is sold out", { productId: id });
      }
    }

    const owned = await c.query<{ product_id: string }>(
      "SELECT product_id FROM core.ownership WHERE user_id = $1 AND product_id = ANY($2::uuid[])",
      [input.userId, productIds],
    );
    if (owned.rows.length > 0) {
      throw new DomainError("ALREADY_OWNED", "you already own a product in this cart", {
        productId: owned.rows[0]?.product_id,
      });
    }

    const companyIds = [...new Set(products.flatMap((p) => (p.company_id ? [p.company_id] : [])))];
    const { rows: companies } = await c.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM core.company WHERE id = ANY($1::uuid[])",
      [companyIds],
    );
    const owners = new Map(companies.map((co) => [co.id, co.owner_user_id]));

    let coupon: StoredCoupon | null = null;
    if (input.couponCode !== undefined) {
      // exact-code lookup: app_pay cannot list private coupons (migration 0012)
      const { rows } = await c.query<CouponRow>(
        `SELECT ${COUPON_COLUMNS} FROM core.find_coupon($1, $2::uuid[])`,
        [normaliseCode(input.couponCode), companyIds],
      );
      const row = rows[0];
      const problem = await couponProblem(c, row, input.userId, owners);
      if (problem || !row) throw new DomainError(...(problem ?? ["COUPON_INVALID", "coupon is not valid"]));
      coupon = {
        id: row.id,
        companyId: row.company_id,
        code: row.code_normalised,
        kind: row.kind,
        value: row.value,
        minSpendPaise: row.min_spend_paise,
      };
    }

    for (const id of productIds) {
      const p = byId.get(id);
      if (p?.company_id && (!owners.has(p.company_id) || owners.get(p.company_id) === input.userId)) {
        throw new DomainError(
          owners.has(p.company_id) ? "SELF_PURCHASE" : "PRODUCT_UNAVAILABLE",
          "you cannot buy from your own company",
          { productId: id },
        );
      }
    }

    const lines: StoredLine[] = productIds.map((id) => {
      const p = byId.get(id) as ProductRow; // checked above: every id has a published row
      return {
        productId: id,
        productVersionId: p.version_id as string,
        sellerId: p.company_id ?? SEED_SELLER,
        companyId: p.company_id,
        listPaise: p.price_paise as string,
        freeStdDelivery: p.free_standard_delivery,
        inventoryMode: p.inventory_mode,
      };
    });

    const hub = await c.query<{ product_id: string }>(
      `SELECT DISTINCT u.product_id FROM core.inventory_unit u JOIN core.warehouse w ON w.id = u.warehouse_id
        WHERE u.product_id = ANY($1::uuid[]) AND u.state = 'AVAILABLE' AND w.zap_hub`,
      [productIds],
    );
    const inHub = new Set(hub.rows.map((r) => r.product_id));
    const speedBySeller: Record<string, Speed> = {};
    for (const sellerId of new Set(lines.map((l) => l.sellerId))) {
      const speed = input.speedBySeller[sellerId];
      if (!speed)
        throw new DomainError("VALIDATION_FAILED", "choose a delivery speed for every seller", { sellerId });
      const own = productIds.flatMap((id) => {
        const p = byId.get(id);
        return p && (p.company_id ?? SEED_SELLER) === sellerId ? [p] : [];
      });
      if (!speedOffered(speed, sellerId, own, inHub))
        throw new DomainError("DELIVERY_UNAVAILABLE", "that delivery speed is not offered", { sellerId });
      speedBySeller[sellerId] = speed;
    }

    if (input.addressId !== undefined) {
      const a = await c.query("SELECT 1 FROM private.address WHERE id = $1", [input.addressId]);
      if ((a.rowCount ?? 0) === 0) throw new DomainError("NOT_FOUND", "address not found");
    }

    const member = await isMember(c, input.userId);
    const priced = priceLines(
      lines.map((l) => ({ ...l, listPaise: BigInt(l.listPaise) })),
      coupon,
      speedBySeller,
      member,
      cfg,
    );

    const quote: StoredQuote = {
      version: 1,
      lines,
      speedBySeller,
      coupon,
      isMember: member,
      addressId: input.addressId ?? null,
      configVersion,
      sellers: storedSellers(priced),
      totalPaise: priced.buyerTotal.toString(),
    };
    const sessionId = uuidv7();
    const { rows } = await c.query<{ expires_at: Date }>(
      `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
       VALUES ($1, $2, 'PRODUCT_PURCHASE', $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING expires_at`,
      [
        sessionId,
        input.userId,
        JSON.stringify(quote),
        quote.totalPaise,
        configVersion,
        cfg.sessionTtlSeconds,
      ],
    );
    const expiresAt = (rows[0]?.expires_at ?? new Date()).toISOString();
    await idemComplete(c, input.userId, "checkout.create", input.idempotencyKey, 201, {
      sessionId,
      expiresAt,
      quote,
    });
    return sessionResult(sessionId, expiresAt, quote);
  });
}

// ---------------------------------------------------------------------------- B2: payment attempt

interface CardRow {
  status: string;
  merchant_scope: string;
}

function cardProblem(card: CardRow | undefined): [ErrorCode, string] | null {
  if (!card) return ["CARD_NOT_OWNED", "card not found for this user"];
  if (card.status === "FROZEN") return ["CARD_FROZEN", "card is frozen"];
  if (card.status !== "ACTIVE") return ["CARD_REPLACED", "card has been replaced"];
  if (card.merchant_scope !== "DELULUMART") return ["MERCHANT_NOT_ALLOWED", "card cannot be used here"];
  return null;
}

async function switchEnabled(c: PoolClient, name: string): Promise<boolean> {
  const { rows } = await c.query<{ enabled: boolean }>(
    "SELECT enabled FROM core.system_switch WHERE name = $1",
    [name],
  );
  return rows[0]?.enabled === true;
}

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
  return asPay(pool, input.userId, async (c) => {
    const { rows } = await c.query<{ state: string; expired: boolean }>(
      "SELECT state, expires_at <= clock_timestamp() AS expired FROM core.checkout_session WHERE id = $1 AND user_id = $2",
      [input.sessionId, input.userId],
    );
    const session = rows[0];
    if (!session) throw new DomainError("NOT_FOUND", "checkout session not found");
    if (session.state !== "OPEN") throw new DomainError("CONFLICT", "checkout session is no longer open");
    if (session.expired) throw new DomainError("CHECKOUT_EXPIRED", "checkout session has expired");
    if (input.method === "CARD") {
      if (!(await switchEnabled(c, "payments_card"))) {
        throw new DomainError("METHOD_UNAVAILABLE", "card payments are switched off");
      }
      const card = await c.query<CardRow>(
        "SELECT status, merchant_scope FROM core.virtual_card WHERE id = $1 AND user_id = $2",
        [input.cardId, input.userId],
      );
      const problem = cardProblem(card.rows[0]);
      if (problem) throw new DomainError(...problem);
    }
    const attemptId = uuidv7();
    const reference = `DLP-${randomBytes(10).toString("hex").toUpperCase()}`;
    await c.query(
      `INSERT INTO core.payment_attempt (id, session_id, user_id, method, card_id, reference, authenticated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $4 = 'BALANCE' THEN now() END)`,
      [attemptId, input.sessionId, input.userId, input.method, input.cardId ?? null, reference],
    );
    return { attemptId, reference, method: input.method, authenticated: input.method === "BALANCE" };
  });
}

/**
 * Marks a PENDING CARD attempt authenticated. PIN verification is out of scope here:
 * only the caller that has just verified the PIN (under the card lock) calls this.
 */
export async function markAttemptAuthenticated(
  pool: Pool,
  input: { userId: string; attemptId: string },
): Promise<void> {
  requireUuid(input.attemptId, "attemptId");
  await asPay(pool, input.userId, async (c) => {
    const { rows } = await c.query<{ state: string; method: string }>(
      "SELECT state, method FROM core.payment_attempt WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [input.attemptId, input.userId],
    );
    const attempt = rows[0];
    if (!attempt) throw new DomainError("NOT_FOUND", "payment attempt not found");
    if (attempt.state !== "PENDING" || attempt.method !== "CARD") {
      throw new DomainError("CONFLICT", "only a pending card attempt can be authenticated");
    }
    // the database stamps the time itself and refuses a second authentication (0016)
    await c.query("UPDATE core.payment_attempt SET authenticated_at = now() WHERE id = $1", [
      input.attemptId,
    ]);
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

function receiptOf(r: StoredReceipt): PayReceipt {
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
  };
}

function fail(code: ErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new PayFailure(code, message, details);
}

const PAY = "pay";
const FAILURE_STATUS = 422;

/**
 * LLD §5.2 pay transaction. Idempotent per (user, key); one success per session.
 * Validation failures roll back every business write; the attempt is then recorded
 * FAILED and the failure stored under the key in a second short transaction.
 */
export async function pay(pool: Pool, input: PayInput): Promise<PayReceipt> {
  requireKey(input.idempotencyKey);
  requireUuid(input.sessionId, "sessionId");
  requireUuid(input.attemptId, "attemptId");
  const hash = requestHash(PAY, { sessionId: input.sessionId, attemptId: input.attemptId });
  try {
    return await asPay(pool, input.userId, (c) => payTransaction(c, input, hash));
  } catch (error) {
    if (error instanceof PayFailure && !error.replayed) await recordFailure(pool, input, hash, error);
    throw error;
  }
}

async function recordFailure(pool: Pool, input: PayInput, hash: Buffer, failure: PayFailure): Promise<void> {
  try {
    await asPay(pool, input.userId, async (c) => {
      const idem = await idemBegin(c, input.userId, PAY, input.idempotencyKey, hash);
      if (!idem.completed) {
        await idemComplete(c, input.userId, PAY, input.idempotencyKey, FAILURE_STATUS, {
          error: { code: failure.code, message: failure.message },
        });
      }
      await c.query(
        `UPDATE core.payment_attempt SET state = 'FAILED', failure_code = $3
          WHERE id = $1 AND session_id = $2 AND state = 'PENDING'`,
        [input.attemptId, input.sessionId, failure.code],
      );
    });
  } catch (error) {
    // A busy key or a concurrent duplicate already recording it: the client retries
    // with the same key and gets the stored outcome. Anything else is a real fault.
    if (!(error instanceof DomainError && (error.code === "BUSY" || error.code === "CONFLICT"))) throw error;
  }
}

interface SessionRow {
  state: string;
  expired: boolean;
  quote: unknown;
  total_paise: string;
  config_version: number;
}

interface AttemptRow {
  session_id: string;
  method: string;
  card_id: string | null;
  state: string;
  authenticated: boolean;
  reference: string;
}

interface LockedProduct {
  id: string;
  company_id: string | null;
  status: string;
  current_version_id: string | null;
  inventory_mode: string;
  available_units: number;
  offers_express: boolean;
  free_standard_delivery: boolean;
  zap_flag: boolean;
}

interface VersionRow {
  id: string;
  product_id: string;
  price_paise: string;
  name: string;
  revision: number;
  template_id: number;
}

interface UnitRow {
  id: string;
  warehouse_id: string;
  serial: number | null;
  zap_hub: boolean;
}

/**
 * The only things pay takes from the stored quote: the buyer's choices. Everything the
 * database knows (sellers, prices, versions, coupon terms, delivery eligibility, fees) is
 * re-read from locked rows. A stored version id is used only to refuse a changed product.
 */
interface QuoteChoices {
  productIds: string[];
  quotedVersion: Map<string, string>;
  speedBySeller: Map<string, Speed>;
  couponId: string | null;
  addressId: string | null;
}

function choicesOf(raw: unknown): QuoteChoices | null {
  const q = asRecord(raw);
  if (!q || !Array.isArray(q.lines) || q.lines.length === 0) return null;
  const productIds: string[] = [];
  const quotedVersion = new Map<string, string>();
  for (const item of q.lines) {
    const line = asRecord(item);
    const id = line?.productId;
    if (typeof id !== "string" || !UUID.test(id) || productIds.includes(id)) return null;
    productIds.push(id);
    if (typeof line?.productVersionId === "string") quotedVersion.set(id, line.productVersionId);
  }
  const speeds = asRecord(q.speedBySeller);
  if (!speeds) return null;
  const speedBySeller = new Map<string, Speed>();
  for (const [seller, speed] of Object.entries(speeds)) {
    if (!SPEEDS.includes(speed as Speed)) return null;
    speedBySeller.set(seller, speed as Speed);
  }
  let couponId: string | null = null;
  if (q.coupon !== null && q.coupon !== undefined) {
    const id = asRecord(q.coupon)?.id;
    if (typeof id !== "string" || !UUID.test(id)) return null;
    couponId = id;
  }
  let addressId: string | null = null;
  if (q.addressId !== null && q.addressId !== undefined) {
    if (typeof q.addressId !== "string" || !UUID.test(q.addressId)) return null;
    addressId = q.addressId;
  }
  return { productIds, quotedVersion, speedBySeller, couponId, addressId };
}

/** Coupon terms from the locked coupon row (never from the stored quote). */
function couponFromRow(row: CouponRow): StoredCoupon {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code_normalised,
    kind: row.kind,
    value: row.value,
    minSpendPaise: row.min_spend_paise,
  };
}

async function payTransaction(c: PoolClient, input: PayInput, hash: Buffer): Promise<PayReceipt> {
  const { userId } = input;

  // 1. idempotency
  const idem = await idemBegin(c, userId, PAY, input.idempotencyKey, hash);
  if (idem.completed) {
    if (idem.status === 200) return receiptOf(idem.response as StoredReceipt);
    const err = (idem.response as { error?: { code?: ErrorCode; message?: string } }).error;
    throw new PayFailure(err?.code ?? "VALIDATION_FAILED", err?.message ?? "payment failed", {}, true);
  }

  // 2. switches, read inside the transaction; missing or unreadable refuses
  if (!(await switchEnabled(c, "purchases"))) {
    throw new DomainError("MAINTENANCE", "purchases are switched off");
  }

  // 3. locks in canonical order (LLD §4), validating each as it is taken
  // #1 checkout session (the buyer's own; RLS and the explicit user check agree)
  const sessionRes = await c.query<SessionRow>(
    `SELECT state, expires_at <= clock_timestamp() AS expired, quote, total_paise::text, config_version
       FROM core.checkout_session WHERE id = $1 AND user_id = $2 AND type = 'PRODUCT_PURCHASE' FOR UPDATE`,
    [input.sessionId, userId],
  );
  const session = sessionRes.rows[0];
  if (!session) fail("NOT_FOUND", "checkout session not found");
  if (session.state !== "OPEN") fail("CONFLICT", "checkout session is no longer open");
  if (session.expired) fail("CHECKOUT_EXPIRED", "checkout session has expired");

  const attemptRes = await c.query<AttemptRow>(
    `SELECT session_id, method, card_id, state, authenticated_at IS NOT NULL AS authenticated, reference
       FROM core.payment_attempt WHERE id = $1 AND user_id = $2`,
    [input.attemptId, userId],
  );
  const attempt = attemptRes.rows[0];
  if (!attempt) fail("NOT_FOUND", "payment attempt not found");
  if (attempt.session_id !== input.sessionId) fail("VALIDATION_FAILED", "attempt belongs to another session");
  if (attempt.state !== "PENDING") fail("CONFLICT", "payment attempt is no longer pending");
  if (!attempt.authenticated) {
    // retryable: the client completes the challenge, then retries with the same key
    throw new DomainError("PAYMENT_PENDING", "payment is awaiting authentication");
  }
  if (attempt.method !== "BALANCE" && attempt.method !== "CARD")
    fail("METHOD_UNAVAILABLE", "method not offered");
  if (attempt.method === "CARD" && !(await switchEnabled(c, "payments_card"))) {
    fail("METHOD_UNAVAILABLE", "card payments are switched off");
  }

  const choices = choicesOf(session.quote);
  if (!choices) fail("VALIDATION_FAILED", "the checkout session's choices cannot be read");
  const { cfg } = await loadConfig(c, session.config_version);
  if (choices.productIds.length > cfg.maxLines) fail("VALIDATION_FAILED", "too many lines");
  const productIds = [...choices.productIds].sort();

  // Sellers and inventory modes as currently recorded (re-checked once the rows are locked
  // at #6): the companies to lock at #4 and the stocked products whose warehouses #5 locks.
  const preRes = await c.query<{ id: string; company_id: string | null; inventory_mode: string }>(
    "SELECT id, company_id, inventory_mode FROM core.product WHERE id = ANY($1::uuid[])",
    [productIds],
  );
  const pre = new Map(preRes.rows.map((p) => [p.id, p]));
  const companyIds = [...new Set(preRes.rows.flatMap((p) => (p.company_id ? [p.company_id] : [])))].sort();
  const stockedIds = preRes.rows.filter((p) => isStocked(p.inventory_mode)).map((p) => p.id);

  // #2 coupon: its terms come from this locked row only
  let coupon: CouponRow | undefined;
  if (choices.couponId) {
    const r = await c.query<CouponRow>(`SELECT ${COUPON_COLUMNS} FROM core.coupon WHERE id = $1 FOR UPDATE`, [
      choices.couponId,
    ]);
    coupon = r.rows[0];
  }

  // #3 membership (read: pay never changes it)
  const member = await isMember(c, userId);

  // #4 selling companies, ascending id. app_pay may lock only companies with a published
  // product (RLS pay_lock_seller); its UPDATE privilege cannot change them.
  const companies = await c.query<{ id: string; owner_user_id: string }>(
    "SELECT id, owner_user_id FROM core.company WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [companyIds],
  );
  const ownerByCompany = new Map(companies.rows.map((co) => [co.id, co.owner_user_id]));
  const sellerAccounts = await c.query<{ id: string; user_id: string }>(
    "SELECT id, user_id FROM ledger.ledger_account WHERE type = 'USER' AND user_id = ANY($1::uuid[])",
    [[...new Set(ownerByCompany.values())]],
  );
  const accountByOwner = new Map(sellerAccounts.rows.map((a) => [a.user_id, a.id]));

  // #5 warehouses holding available units of the stocked products
  if (stockedIds.length > 0) {
    await c.query(
      `SELECT w.id FROM core.warehouse w
        WHERE w.id IN (SELECT u.warehouse_id FROM core.inventory_unit u
                        WHERE u.product_id = ANY($1::uuid[]) AND u.state = 'AVAILABLE')
        ORDER BY w.id FOR UPDATE`,
      [stockedIds],
    );
  }

  // #6 products, then their current versions
  const productRes = await c.query<LockedProduct>(
    `SELECT id, company_id, status, current_version_id, inventory_mode, available_units, offers_express,
            free_standard_delivery, zap_flag
       FROM core.product WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [productIds],
  );
  const products = new Map(productRes.rows.map((p) => [p.id, p]));
  const versionRes = await c.query<VersionRow>(
    `SELECT id, product_id, price_paise::text, name, revision, template_id
       FROM core.product_version WHERE id = ANY($1::uuid[])`,
    [productRes.rows.flatMap((p) => (p.current_version_id ? [p.current_version_id] : []))],
  );
  const versions = new Map(versionRes.rows.map((v) => [v.id, v]));
  const sellerOf = (p: LockedProduct): string => p.company_id ?? SEED_SELLER;

  // #7 inventory units: lowest AVAILABLE serial per stocked product, ascending product id;
  // Zap from a user company ships only from a Zap hub warehouse
  const units = new Map<string, UnitRow>();
  for (const id of productIds) {
    const p = products.get(id);
    if (p?.status !== "PUBLISHED" || !isStocked(p.inventory_mode)) continue;
    const hubOnly = p.company_id !== null && choices.speedBySeller.get(sellerOf(p)) === "ZAP";
    const u = await c.query<UnitRow>(
      `SELECT u.id, u.warehouse_id, u.serial, w.zap_hub FROM core.inventory_unit u
         JOIN core.warehouse w ON w.id = u.warehouse_id
        WHERE u.product_id = $1 AND u.state = 'AVAILABLE' AND (NOT $2::boolean OR w.zap_hub)
        ORDER BY u.serial NULLS LAST, u.id LIMIT 1 FOR UPDATE OF u`,
      [id, hubOnly],
    );
    const unit = u.rows[0];
    if (unit) units.set(id, unit);
  }

  // #8 card: the buyer's own (RLS and the explicit user check agree)
  let card: CardRow | undefined;
  if (attempt.method === "CARD") {
    const r = await c.query<CardRow>(
      "SELECT status, merchant_scope FROM core.virtual_card WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [attempt.card_id, userId],
    );
    card = r.rows[0];
  }

  const buyerAccount = await c.query<{ id: string }>(
    "SELECT id FROM ledger.ledger_account WHERE user_id = $1 AND type = 'USER'",
    [userId],
  );
  const buyerAccountId = buyerAccount.rows[0]?.id;
  if (!buyerAccountId) fail("FORBIDDEN", "buyer has no ledger account");

  // 4. re-validate everything against the locked state and rebuild the quote from it
  if (attempt.method === "CARD") {
    const problem = cardProblem(card);
    if (problem) fail(...problem);
  }

  const owned = await c.query<{ product_id: string }>(
    "SELECT product_id FROM core.ownership WHERE user_id = $1 AND product_id = ANY($2::uuid[])",
    [userId, productIds],
  );
  const ownedIds = new Set(owned.rows.map((r) => r.product_id));

  interface Line {
    product: LockedProduct;
    version: VersionRow;
    sellerId: string;
  }
  const lines: Line[] = [];
  for (const productId of choices.productIds) {
    if (ownedIds.has(productId)) fail("ALREADY_OWNED", "you already own this product", { productId });
    const p = products.get(productId);
    if (p?.status !== "PUBLISHED")
      fail("PRODUCT_UNAVAILABLE", "a product is no longer available", { productId });
    const v = p.current_version_id ? versions.get(p.current_version_id) : undefined;
    const quoted = choices.quotedVersion.get(productId);
    if (!v || v.product_id !== productId || (quoted !== undefined && quoted !== v.id)) {
      fail("CART_CHANGED", "a product changed since the quote", { productId });
    }
    if ((pre.get(productId)?.company_id ?? null) !== p.company_id) {
      fail("CART_CHANGED", "a product changed since the quote", { productId });
    }
    if (p.company_id) {
      const owner = ownerByCompany.get(p.company_id);
      if (!owner || !accountByOwner.has(owner)) {
        fail("PRODUCT_UNAVAILABLE", "the seller is not available", { productId });
      }
      if (owner === userId) fail("SELF_PURCHASE", "you cannot buy from your own company", { productId });
    }
    if (isStocked(p.inventory_mode) && (p.available_units <= 0 || !units.has(p.id))) {
      const speed = choices.speedBySeller.get(sellerOf(p));
      if (p.available_units > 0 && p.company_id && speed === "ZAP") {
        fail("DELIVERY_UNAVAILABLE", "no unit in a Zap hub", { productId });
      }
      fail("SOLD_OUT", "a product sold out", { productId });
    }
    lines.push({ product: p, version: v, sellerId: sellerOf(p) });
  }

  // delivery: the buyer chose a speed per seller; eligibility comes from the product rows
  const hubUnits = new Set([...units].flatMap(([id, u]) => (u.zap_hub ? [id] : [])));
  const speedBySeller: Record<string, Speed> = {};
  for (const sellerId of new Set(lines.map((l) => l.sellerId))) {
    const speed = choices.speedBySeller.get(sellerId);
    if (!speed) fail("CART_CHANGED", "the sellers changed since the quote", { sellerId });
    const own = lines.filter((l) => l.sellerId === sellerId).map((l) => l.product);
    if (!speedOffered(speed, sellerId, own, hubUnits)) {
      fail("DELIVERY_UNAVAILABLE", "that delivery speed is not offered", { sellerId });
    }
    speedBySeller[sellerId] = speed;
  }

  let couponTerms: StoredCoupon | null = null;
  if (choices.couponId) {
    const problem = await couponProblem(c, coupon, userId, ownerByCompany);
    if (problem || !coupon) fail(...(problem ?? ["COUPON_INVALID", "coupon is not valid"]));
    couponTerms = couponFromRow(coupon);
  }

  if (choices.addressId) {
    const a = await c.query("SELECT 1 FROM private.address WHERE id = $1 AND user_id = $2", [
      choices.addressId,
      userId,
    ]);
    if ((a.rowCount ?? 0) === 0) choices.addressId = null; // removed since the quote; shipment keeps no address
  }

  let priced: Priced;
  try {
    priced = priceLines(
      lines.map((l) => ({
        productId: l.product.id,
        sellerId: l.sellerId,
        listPaise: BigInt(l.version.price_paise),
        freeStdDelivery: l.product.free_standard_delivery,
      })),
      couponTerms,
      speedBySeller,
      member,
      cfg,
    );
  } catch (error) {
    if (error instanceof DomainError) fail(error.code, error.message, { ...error.details });
    throw error;
  }
  if (priced.buyerTotal !== BigInt(session.total_paise))
    fail("CART_CHANGED", "the total changed since the quote");

  // #9 wallets: buyer and every seller, ascending account id (inside ledger.sync_wallets,
  // which waits at most 2 s). Taken as late as possible: only once everything else is locked
  // and validated, so a refused purchase never queues on (or holds) anyone's wallet.
  const walletAccounts = [...new Set([buyerAccountId, ...accountByOwner.values()])].sort();
  await c.query("SELECT ledger.sync_wallets($1::uuid[])", [walletAccounts]);
  const buyerWallet = await c.query<{ available_paise: string }>(
    "SELECT available_paise::text FROM ledger.wallet WHERE account_id = $1 FOR UPDATE",
    [buyerAccountId],
  );
  const available = BigInt(buyerWallet.rows[0]?.available_paise ?? "0");

  // #10 entitlement (read under the buyer's wallet lock, which serialises this user's
  // purchases; the unique user_id is the last line of defence)
  const ent = await c.query("SELECT 1 FROM core.creator_entitlement WHERE user_id = $1", [userId]);
  const hasEntitlement = (ent.rowCount ?? 0) > 0;

  if (available < priced.buyerTotal) fail("INSUFFICIENT_FUNDS", "not enough fictional balance");

  // 5. write
  const journalId = uuidv7();
  const groupId = uuidv7();
  const sellerOrderIds = new Map(priced.perSeller.map((s) => [s.sellerId, uuidv7()]));

  await c.query(
    `INSERT INTO ledger.journal (id, event_type, config_version, order_group_id, idempotency_ref)
     VALUES ($1, 'PURCHASE', $2, $3, $4)`,
    [journalId, session.config_version, groupId, input.attemptId],
  );
  const postAccounts: string[] = [];
  const postAmounts: string[] = [];
  const postSellerOrders: (string | null)[] = [];
  const postMemos: string[] = [];
  for (const posting of priced.postings) {
    let account: string;
    let sellerOrder: string | null = null;
    let memo: string;
    if (posting.account === "BUYER") {
      account = buyerAccountId;
      memo = "Purchase";
    } else if (posting.account === "SINK") {
      account = SINK_ACCOUNT_ID;
      memo = "Fees, delivery and seed sales";
    } else if (posting.account === "MINT") {
      account = MINT_ACCOUNT_ID; // platform discount; rejected at commit until platform coupons exist (0016)
      memo = "Platform discount";
    } else {
      const owner = ownerByCompany.get(posting.account);
      const sellerAccount = owner ? accountByOwner.get(owner) : undefined;
      if (!sellerAccount) throw new Error("pay: seller account missing after validation");
      account = sellerAccount;
      sellerOrder = sellerOrderIds.get(posting.account) ?? null;
      memo = "Sale proceeds";
    }
    postAccounts.push(account);
    postAmounts.push(posting.amountPaise.toString());
    postSellerOrders.push(sellerOrder);
    postMemos.push(memo);
  }
  await c.query(
    `INSERT INTO ledger.posting (journal_id, account_id, amount, seller_order_id, memo)
     SELECT $1, a, m::bigint, s, t FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::text[]) AS x(a, m, s, t)`,
    [journalId, postAccounts, postAmounts, postSellerOrders, postMemos],
  );

  // the purchase time is the journal's, stamped by the database clock (migration 0003);
  // shipments are scheduled from it
  const journalTime = await c.query<{ ms: string }>(
    "SELECT floor(extract(epoch FROM created_at) * 1000)::bigint::text AS ms FROM ledger.journal WHERE id = $1",
    [journalId],
  );
  const placedAt = Number(journalTime.rows[0]?.ms);
  if (!Number.isSafeInteger(placedAt)) throw new Error("pay: journal time is not readable");

  const profile = await c.query<{ is_test_account: boolean }>(
    "SELECT is_test_account FROM core.user_profile WHERE id = $1",
    [userId],
  );
  const isTestAccount = profile.rows[0]?.is_test_account === true;
  const buyerSource = isTestAccount ? "STAFF" : "PLAYER";
  await c.query(
    `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source,
                                   total_paise, config_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      groupId,
      userId,
      input.sessionId,
      input.attemptId,
      journalId,
      buyerSource,
      priced.buyerTotal.toString(),
      session.config_version,
    ],
  );

  for (const s of priced.perSeller) {
    await c.query(
      `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise,
         seller_discount_paise, platform_discount_paise, fee_paise, delivery_fee_buyer_paise,
         delivery_fee_seller_paise, net_paise, qualifies_for_progression)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        sellerOrderIds.get(s.sellerId),
        groupId,
        userId,
        s.sellerId === SEED_SELLER ? null : s.sellerId,
        s.sellerId === SEED_SELLER ? "SEED" : "USER",
        s.list.toString(),
        s.sellerDisc.toString(),
        s.platformDisc.toString(),
        s.fee.toString(),
        s.deliveryBuyer.toString(),
        s.deliverySeller.toString(),
        s.net.toString(),
        // a test account's purchase never counts towards a seller's progression; a purchase
        // from one's own company is refused above
        !isTestAccount,
      ],
    );
  }

  for (const line of lines) {
    const p = line.product;
    const v = line.version;
    // the line's position in the pricing input: the database splits a FLAT coupon in this order
    const lineNo = priced.lines.findIndex((l) => l.productId === p.id);
    const out = priced.lines[lineNo];
    if (!out) throw new Error("pay: priced line missing after validation");
    const unit = units.get(p.id) ?? null;
    const lineId = uuidv7();
    const snapshot = {
      productVersionId: v.id,
      revision: v.revision,
      name: v.name,
      templateId: v.template_id,
      listPaise: v.price_paise,
      sellerType: p.company_id ? "USER" : "SEED",
      companyId: p.company_id,
      inventoryMode: p.inventory_mode,
    };
    await c.query(
      `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
         seller_discount_paise, platform_discount_paise, fee_paise, inventory_unit_id, edition_serial, line_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        lineId,
        sellerOrderIds.get(line.sellerId),
        p.id,
        v.id,
        JSON.stringify(snapshot),
        out.listPaise.toString(),
        out.sellerDisc.toString(),
        out.platformDisc.toString(),
        out.fee.toString(),
        unit?.id ?? null,
        p.inventory_mode === "EXCLUSIVE" ? (unit?.serial ?? null) : null,
        lineNo,
      ],
    );
    await c.query(
      "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
      [uuidv7(), userId, p.id, lineId],
    );
    if (unit) {
      await c.query("UPDATE core.inventory_unit SET state = 'ISSUED', order_line_id = $2 WHERE id = $1", [
        unit.id,
        lineId,
      ]);
      await c.query("UPDATE core.product SET available_units = available_units - 1 WHERE id = $1", [p.id]);
      await c.query("UPDATE core.warehouse SET used = used - 1 WHERE id = $1", [unit.warehouse_id]);
      // core.stock_movement does not exist yet; when it is created, record the ISSUE here.
    }
  }

  if (couponTerms && coupon) {
    const discount = priced.perSeller
      .filter((s) => s.sellerId === couponTerms?.companyId)
      .reduce((sum, s) => sum + s.sellerDisc, 0n);
    await c.query("UPDATE core.coupon SET redeemed = redeemed + 1 WHERE id = $1", [coupon.id]);
    await c.query(
      "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, $4)",
      [coupon.id, userId, groupId, discount.toString()],
    );
  }

  for (const s of priced.perSeller) {
    const t = computeShipmentSchedule(s.speed, placedAt, cfg.durations);
    const iso = (ms: number) => new Date(ms).toISOString();
    await c.query(
      `INSERT INTO core.shipment (id, seller_order_id, speed, address_id, placed_at, packed_at, shipped_at, out_at, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidv7(),
        sellerOrderIds.get(s.sellerId),
        s.speed,
        choices.addressId,
        iso(t.placedAt),
        iso(t.packedAt),
        iso(t.shippedAt),
        iso(t.outForDeliveryAt),
        iso(t.deliveredAt),
      ],
    );
  }

  // wallets follow the postings (CHECK available_paise >= 0 is the last line of defence)
  await c.query("SELECT ledger.sync_wallets($1::uuid[])", [walletAccounts]);
  const after = await c.query<{ available_paise: string }>(
    "SELECT available_paise::text FROM ledger.wallet WHERE account_id = $1",
    [buyerAccountId],
  );
  const balanceAfter = BigInt(after.rows[0]?.available_paise ?? "-1");
  if (balanceAfter !== available - priced.buyerTotal)
    throw new Error("pay: buyer wallet did not follow postings");

  let creatorUnlocked = false;
  if (!hasEntitlement && shouldUnlockCreator(balanceAfter, cfg.creatorThresholdPaise)) {
    const ins = await c.query(
      `INSERT INTO core.creator_entitlement (id, user_id, source, evidence_order_group_id)
       VALUES ($1, $2, 'PURCHASE_THRESHOLD', $3) ON CONFLICT (user_id) DO NOTHING`,
      [uuidv7(), userId, groupId],
    );
    creatorUnlocked = (ins.rowCount ?? 0) > 0;
  }

  await c.query("UPDATE core.payment_attempt SET state = 'SUCCEEDED' WHERE id = $1", [input.attemptId]);
  await c.query("UPDATE core.checkout_session SET state = 'SUCCEEDED' WHERE id = $1", [input.sessionId]);

  const sellerTotals = priced.perSeller.map((s) => ({
    sellerId: s.sellerId,
    sellerOrderId: sellerOrderIds.get(s.sellerId) ?? "",
    totalPaise: (s.list - s.sellerDisc - s.platformDisc + s.deliveryBuyer).toString(),
  }));
  // ids and amounts only: no personal data in outbox payloads (invariant 8)
  await c.query(
    `INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version)
     VALUES ($1, 'purchase_completed', $2, $3, 1)`,
    [
      uuidv7(),
      groupId,
      JSON.stringify({
        orderGroupId: groupId,
        journalId,
        sessionId: input.sessionId,
        paymentAttemptId: input.attemptId,
        buyerUserId: userId,
        configVersion: session.config_version,
        totalPaise: priced.buyerTotal.toString(),
        sellerOrders: sellerTotals,
        productIds,
        creatorUnlocked,
      }),
    ],
  );

  const stored: StoredReceipt = {
    orderGroupId: groupId,
    paymentReference: attempt.reference,
    sellers: sellerTotals,
    totalPaise: priced.buyerTotal.toString(),
    balanceAfterPaise: balanceAfter.toString(),
    creatorUnlocked,
  };
  await idemComplete(c, userId, PAY, input.idempotencyKey, 200, stored);
  return receiptOf(stored);
}
