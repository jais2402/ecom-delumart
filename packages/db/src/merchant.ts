/**
 * The merchant side of a store (migrations 0020, 0041, 0042): coupons, seller orders, earnings,
 * brand progress and inventory, for the signed-in owner of a company, run as app_web. The database
 * derives the company from the sign-in session; another company's order is NOT_FOUND. No buyer
 * identity is ever returned: a buyer is "Anonymous player" and buyers are only counted. Money is
 * bigint paise.
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import type { Page } from "./account";
import { asWeb, one, requireUuid } from "./command";

type Json = Record<string, unknown>;

interface Session {
  authSessionId: string;
}

const date = (v: unknown): Date => new Date(String(v));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const paise = (v: unknown): bigint => BigInt(String(v));
const paiseOrNull = (v: unknown): bigint | null => (v === null || v === undefined ? null : paise(v));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ------------------------------------------------------------------ coupons
export type CouponStatus = "ACTIVE" | "PAUSED" | "ENDED" | "ARCHIVED";

export interface CouponTerms {
  kind: "PERCENT" | "FLAT";
  /** PERCENT coupons: the whole percent off. */
  percent: number | null;
  /** FLAT coupons: the amount off. */
  amountPaise: bigint | null;
  minSpendPaise: bigint;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
}

export interface MerchantCoupon extends CouponTerms {
  couponId: string;
  /** The code (a private coupon's generated code is shown to its company's owner only). */
  code: string;
  isPublic: boolean;
  status: CouponStatus;
  redeemed: number;
  discountGivenPaise: bigint;
}

export interface PublicCoupon extends CouponTerms {
  code: string;
}

function termsOf(j: Json): CouponTerms {
  return {
    kind: j.kind as "PERCENT" | "FLAT",
    percent: j.percent === null || j.percent === undefined ? null : Number(j.percent),
    amountPaise: paiseOrNull(j.amountPaise),
    minSpendPaise: paise(j.minSpendPaise ?? "0"),
    startsAt: dateOrNull(j.startsAt),
    endsAt: dateOrNull(j.endsAt),
    maxRedemptions:
      j.maxRedemptions === null || j.maxRedemptions === undefined ? null : Number(j.maxRedemptions),
  };
}

export interface MyCoupons {
  items: MerchantCoupon[];
  activeCount: number;
  activeMax: number;
}

export async function myCoupons(pool: Pool, input: Session): Promise<MyCoupons> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[]; activeCount: number; activeMax: number; hasCompany: boolean }>(
      c,
      "SELECT core.my_coupons() AS r",
      [],
    ),
  );
  if (!r.hasCompany) throw new DomainError("COMPANY_FEE_REQUIRED", "register a company first");
  return {
    items: r.items.map((i) => ({
      ...termsOf(i),
      couponId: String(i.couponId),
      code: String(i.code),
      isPublic: i.isPublic === true,
      status: i.status as CouponStatus,
      redeemed: Number(i.redeemed),
      discountGivenPaise: paise(i.discountGivenPaise),
    })),
    activeCount: Number(r.activeCount),
    activeMax: Number(r.activeMax),
  };
}

export interface CouponInput {
  kind: "PERCENT" | "FLAT";
  /** PERCENT: whole percent; FLAT: paise. */
  value: bigint;
  minSpendPaise?: bigint | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  isPublic: boolean;
  publicCode?: string | null;
}

/** Creates a coupon of the owner's company; returns its id and code (a private one's is generated). */
export async function createCoupon(
  pool: Pool,
  input: Session & { coupon: CouponInput },
): Promise<{ couponId: string; code: string }> {
  const k = input.coupon;
  return asWeb(pool, input.authSessionId, async (c) => {
    const mine = await one<{ company: { companyId: string } | null }>(c, "SELECT core.my_company() AS r", []);
    if (mine.company === null) throw new DomainError("COMPANY_FEE_REQUIRED", "register a company first");
    return one<{ couponId: string; code: string }>(
      c,
      "SELECT core.create_coupon($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r",
      [
        mine.company.companyId,
        k.kind,
        k.value.toString(),
        (k.minSpendPaise ?? 0n).toString(),
        k.startsAt ?? null,
        k.endsAt ?? null,
        k.maxRedemptions ?? null,
        k.isPublic,
        k.publicCode ?? null,
      ],
    );
  });
}

export async function setCouponStatus(
  pool: Pool,
  input: Session & { couponId: string; status: CouponStatus },
): Promise<void> {
  requireUuid(input.couponId, "couponId");
  await asWeb(pool, input.authSessionId, (c) =>
    c.query("SELECT core.set_coupon_status($1, $2)", [input.couponId, input.status]),
  );
}

/** A store's public coupons usable now (code and terms). Needs no sign-in session. */
export async function storeCoupons(pool: Pool, handle: string): Promise<PublicCoupon[]> {
  const r = await asWeb(pool, null, (c) =>
    one<{ items: Json[] }>(c, "SELECT core.store_coupons($1) AS r", [handle]),
  );
  return r.items.map((i) => ({ ...termsOf(i), code: String(i.code) }));
}

// ------------------------------------------------------------------ seller orders
export interface SellerOrderLineView {
  productId: string;
  name: string;
  editionSerial: number | null;
  listPaise: bigint;
  discountPaise: bigint;
  feePaise: bigint;
}

/**
 * A seller order's reference as its seller sees it (0055): opaque, random and stable, never derived
 * from an id or a time. Seller reads take it instead of an id.
 */
export const ORDER_REF = /^SO-[A-Z2-9]{16}$/;

export function isOrderRef(value: unknown): value is string {
  return typeof value === "string" && ORDER_REF.test(value);
}

export interface MerchantOrder {
  /** The opaque per-seller order reference (never the seller order's time-ordered id). */
  orderRef: string;
  orderedAt: Date;
  status: "COMPLETED" | "REVERSED";
  source: "PLAYER" | "STAFF";
  /** Always "Anonymous player": a store never learns who bought. */
  buyer: string;
  listPaise: bigint;
  discountPaise: bigint;
  /** List after the seller discount. */
  grossPaise: bigint;
  feePaise: bigint;
  deliveryFeeBuyerPaise: bigint;
  deliveryFeeSellerPaise: bigint;
  /** What the owner was credited (the ledger posting for this order). */
  netPaise: bigint;
  /**
   * The store's own PUBLIC coupon code used on this order; null for a private coupon (whose code
   * could identify the buyer) and when none was used (0051).
   */
  couponCode: string | null;
  /** Which kind of this store's coupon was used, if any. */
  couponKind: "PUBLIC" | "PRIVATE" | null;
  delivery: {
    speed: "STANDARD" | "EXPRESS" | "ZAP";
    placedAt: Date;
    packedAt: Date;
    shippedAt: Date;
    outAt: Date;
    deliveredAt: Date;
    cancelledAt: Date | null;
  } | null;
  lines: SellerOrderLineView[];
}

function merchantOrderOf(j: Json): MerchantOrder {
  const d = j.delivery as Json | null;
  return {
    orderRef: String(j.orderRef),
    orderedAt: date(j.orderedAt),
    status: j.status as MerchantOrder["status"],
    source: j.source as MerchantOrder["source"],
    buyer: String(j.buyer),
    listPaise: paise(j.listPaise),
    discountPaise: paise(j.discountPaise),
    grossPaise: paise(j.grossPaise),
    feePaise: paise(j.feePaise),
    deliveryFeeBuyerPaise: paise(j.deliveryFeeBuyerPaise),
    deliveryFeeSellerPaise: paise(j.deliveryFeeSellerPaise),
    netPaise: paise(j.netPaise),
    couponCode: textOrNull(j.couponCode),
    couponKind: j.couponKind === "PUBLIC" || j.couponKind === "PRIVATE" ? j.couponKind : null,
    delivery: d
      ? {
          speed: d.speed as "STANDARD" | "EXPRESS" | "ZAP",
          placedAt: date(d.placedAt),
          packedAt: date(d.packedAt),
          shippedAt: date(d.shippedAt),
          outAt: date(d.outAt),
          deliveredAt: date(d.deliveredAt),
          cancelledAt: dateOrNull(d.cancelledAt),
        }
      : null,
    lines: ((j.lines ?? []) as Json[]).map((l) => ({
      productId: String(l.productId),
      name: String(l.name),
      editionSerial:
        l.editionSerial === null || l.editionSerial === undefined ? null : Number(l.editionSerial),
      listPaise: paise(l.listPaise),
      discountPaise: paise(l.discountPaise),
      feePaise: paise(l.feePaise),
    })),
  };
}

export async function mySellerOrders(
  pool: Pool,
  input: Session & { cursor?: string | null; pageSize?: number },
): Promise<Page<MerchantOrder, string>> {
  if (input.cursor != null && !isOrderRef(input.cursor)) {
    throw new DomainError("VALIDATION_FAILED", "cursor is an order reference");
  }
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[]; nextCursor: string | null }>(c, "SELECT core.my_seller_orders($1, $2) AS r", [
      input.cursor ?? null,
      input.pageSize ?? null,
    ]),
  );
  return { items: r.items.map(merchantOrderOf), nextCursor: r.nextCursor };
}

export async function mySellerOrder(
  pool: Pool,
  input: Session & { orderRef: string },
): Promise<MerchantOrder> {
  // a malformed reference is answered as a missing one
  if (!isOrderRef(input.orderRef)) throw new DomainError("NOT_FOUND", "order not found");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.my_seller_order($1) AS r", [input.orderRef]),
  );
  return merchantOrderOf(r);
}

// ------------------------------------------------------------------ earnings
export interface EarningsTotals {
  from: Date;
  to: Date;
  orders: number;
  grossPaise: bigint;
  /** The seller-funded (merchant coupon) discount given on these orders (R8). */
  discountPaise: bigint;
  feesPaise: bigint;
  merchantDeliveryPaise: bigint;
  netPaise: bigint;
  distinctBuyers: number;
  averageOrderPaise: bigint | null;
}

export interface Earnings {
  periodDays: number;
  timeZone: string;
  asOf: Date;
  current: EarningsTotals;
  previous: EarningsTotals;
  staff: { current: EarningsTotals; previous: EarningsTotals };
  daily: { date: string; orders: number; grossPaise: bigint; netPaise: bigint }[];
  topProducts: { productId: string; name: string; units: number; grossPaise: bigint }[];
}

function totalsOf(j: Json): EarningsTotals {
  return {
    from: date(j.from),
    to: date(j.to),
    orders: Number(j.orders),
    grossPaise: paise(j.grossPaise),
    discountPaise: paise(j.discountPaise),
    feesPaise: paise(j.feesPaise),
    merchantDeliveryPaise: paise(j.merchantDeliveryPaise),
    netPaise: paise(j.netPaise),
    distinctBuyers: Number(j.distinctBuyers),
    averageOrderPaise: paiseOrNull(j.averageOrderPaise),
  };
}

export function earningsOf(j: Json): Earnings {
  const staff = j.staff as Json;
  return {
    periodDays: Number(j.periodDays),
    timeZone: String(j.timeZone),
    asOf: date(j.asOf),
    current: totalsOf(j.current as Json),
    previous: totalsOf(j.previous as Json),
    staff: { current: totalsOf(staff.current as Json), previous: totalsOf(staff.previous as Json) },
    daily: ((j.daily ?? []) as Json[]).map((d) => ({
      date: String(d.date),
      orders: Number(d.orders),
      grossPaise: paise(d.grossPaise),
      netPaise: paise(d.netPaise),
    })),
    topProducts: ((j.topProducts ?? []) as Json[]).map((t) => ({
      productId: String(t.productId),
      name: String(t.name),
      units: Number(t.units),
      grossPaise: paise(t.grossPaise),
    })),
  };
}

/** Earnings for the last `days` days (default 7, capped at 90) and the period before. */
export async function myEarnings(pool: Pool, input: Session & { days?: number }): Promise<Earnings> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.my_earnings($1) AS r", [input.days ?? 7]),
  );
  return earningsOf(r);
}

// ------------------------------------------------------------------ brand progress
export interface BrandProgress {
  qualifyingGrossPaise: bigint;
  eligibleBuyers: number;
  thresholdPaise: bigint;
  minBuyers: number;
  buyerMinAgeHours: number;
  grossMet: boolean;
  buyersMet: boolean;
  qualifies: boolean;
  tier: "SOLO" | "BRAND";
  brandUnlocked: boolean;
}

export async function myBrandProgress(pool: Pool, input: Session): Promise<BrandProgress> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.my_brand_progress() AS r", []),
  );
  return {
    qualifyingGrossPaise: paise(r.qualifyingGrossPaise),
    eligibleBuyers: Number(r.eligibleBuyers),
    thresholdPaise: paise(r.thresholdPaise),
    minBuyers: Number(r.minBuyers),
    buyerMinAgeHours: Number(r.buyerMinAgeHours),
    grossMet: r.grossMet === true,
    buyersMet: r.buyersMet === true,
    qualifies: r.qualifies === true,
    tier: r.tier as "SOLO" | "BRAND",
    brandUnlocked: r.brandUnlocked === true,
  };
}

// ------------------------------------------------------------------ inventory
export interface Inventory {
  lowStockThreshold: number;
  warehouses: { id: string; kind: string; capacity: number; used: number; free: number; zapHub: boolean }[];
  products: {
    productId: string;
    name: string | null;
    status: string;
    inventoryMode: string;
    available: number;
    issued: number;
    retired: number;
    lowStock: boolean;
    edition: { supply: number; issued: number } | null;
  }[];
}

export async function myInventory(pool: Pool, input: Session): Promise<Inventory> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.my_inventory() AS r", []),
  );
  return {
    lowStockThreshold: Number(r.lowStockThreshold),
    warehouses: ((r.warehouses ?? []) as Json[]).map((w) => ({
      id: String(w.id),
      kind: String(w.kind),
      capacity: Number(w.capacity),
      used: Number(w.used),
      free: Number(w.free),
      zapHub: w.zapHub === true,
    })),
    products: ((r.products ?? []) as Json[]).map((p) => {
      const e = p.edition as Json | null;
      return {
        productId: String(p.productId),
        name: textOrNull(p.name),
        status: String(p.status),
        inventoryMode: String(p.inventoryMode),
        available: Number(p.available),
        issued: Number(p.issued),
        retired: Number(p.retired),
        lowStock: p.lowStock === true,
        edition: e ? { supply: Number(e.supply), issued: Number(e.issued) } : null,
      };
    }),
  };
}
