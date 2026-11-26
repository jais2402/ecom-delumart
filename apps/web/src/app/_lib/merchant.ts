import { formatInrExact } from "@delulu/core";
import { ApiError } from "./api";
import { parsePaise } from "./money";
import { studioErrorText } from "./studio";

/** Types of the merchant, safety and admin API bodies (money fields are decimal strings). */

export interface DeliveryTimes {
  speed: "STANDARD" | "EXPRESS" | "ZAP";
  placedAt: string;
  packedAt: string;
  shippedAt: string;
  outAt: string;
  deliveredAt: string;
  cancelledAt: string | null;
}

export interface MerchantOrderLine {
  productId: string;
  name: string;
  editionSerial: number | null;
  listPaise: string;
  discountPaise: string;
  feePaise: string;
}

export interface MerchantOrder {
  id: string;
  orderedAt: string;
  status: "COMPLETED" | "REVERSED";
  source: "PLAYER" | "STAFF";
  buyer: string;
  listPaise: string;
  discountPaise: string;
  grossPaise: string;
  feePaise: string;
  deliveryFeeBuyerPaise: string;
  deliveryFeeSellerPaise: string;
  netPaise: string;
  /** Only a PUBLIC coupon's code; a private code could name the buyer. */
  couponCode: string | null;
  couponKind: "PUBLIC" | "PRIVATE" | null;
  delivery: DeliveryTimes | null;
  lines: MerchantOrderLine[];
}

export interface MerchantOrdersPage {
  items: MerchantOrder[];
  nextCursor: string | null;
}

export interface EarningsTotals {
  from: string;
  to: string;
  orders: number;
  grossPaise: string;
  feesPaise: string;
  discountPaise: string;
  merchantDeliveryPaise: string;
  netPaise: string;
  distinctBuyers: number;
  averageOrderPaise: string | null;
}

export interface Earnings {
  periodDays: number;
  timeZone: string;
  asOf: string;
  current: EarningsTotals;
  previous: EarningsTotals;
  staff: { current: EarningsTotals; previous: EarningsTotals };
  daily: { date: string; orders: number; grossPaise: string; netPaise: string }[];
  topProducts: { productId: string; name: string; units: number; grossPaise: string }[];
}

export interface BrandProgress {
  qualifyingGrossPaise: string;
  eligibleBuyers: number;
  thresholdPaise: string;
  minBuyers: number;
  buyerMinAgeHours: number;
  grossMet: boolean;
  buyersMet: boolean;
  qualifies: boolean;
  tier: string;
  brandUnlocked: boolean;
}

export interface InventoryResponse {
  lowStockThreshold: number;
  warehouses: { id: string; kind: string; capacity: number; used: number; free: number; zapHub: boolean }[];
  products: {
    id: string;
    name: string;
    status: string;
    inventoryMode: "STANDARD_STOCKED" | "EXCLUSIVE" | "UNLIMITED_SEED";
    available: number;
    issued: number;
    retired: number;
    lowStock: boolean;
    edition: { supply: number; issued: number } | null;
  }[];
}

export type CouponStatus = "ACTIVE" | "PAUSED" | "ENDED" | "ARCHIVED";

export interface CouponTerms {
  kind: "PERCENT" | "FLAT";
  percent: number | null;
  amountPaise: string | null;
  minSpendPaise: string;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
}

export interface MerchantCoupon extends CouponTerms {
  id: string;
  code: string;
  isPublic: boolean;
  status: CouponStatus;
  redeemed: number;
  discountGivenPaise: string;
}

export interface CouponsResponse {
  items: MerchantCoupon[];
  activeCount: number;
  activeMax: number;
}

export interface PublicCoupon extends CouponTerms {
  code: string;
}

export interface AppealRow {
  id: string;
  productId: string;
  productName: string | null;
  kind: "REJECTION" | "HIDE";
  status: "OPEN" | "UPHELD" | "DENIED";
  statement: string;
  createdAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface MyReport {
  reference: string;
  targetType: "PRODUCT" | "STORE";
  targetId: string;
  reason: string;
  status: "OPEN" | "UPHELD" | "DISMISSED";
  createdAt: string;
  resolvedAt: string | null;
}

export interface BlockRow {
  companyId: string;
  handle: string;
  displayName: string;
  blockedAt: string;
}

export interface ReportCase {
  id: string;
  targetType: "PRODUCT" | "STORE";
  status: string;
  openedAt: string;
  autoHidden: boolean;
  target: unknown;
  reasonCounts: Record<string, number>;
  reporterCount: number;
  qualifyingReporterCount: number;
  reports: {
    reporter: number;
    reason: string;
    detail: string | null;
    detailFlags: string[];
    createdAt: string;
  }[];
}

export interface AppealQueueItem {
  appealId: string;
  productId: string;
  kind: "REJECTION" | "HIDE";
  statement: string;
  createdAt: string;
  productStatus: string;
  store: { handle: string; displayName: string };
  version: { name: string; hook: string | null; description: string; pricePaise: string } | null;
  decision: { action: string; reason: string | null; at: string | null; by: string | null } | null;
  evidence: {
    reasons: { field: string; code: string }[];
    reports: { caseId: string; reasonCounts: Record<string, number>; reporterCount: number } | null;
  };
}

export const REPORT_REASON_LABEL: Record<string, string> = {
  SEXUAL: "Sexual or adult content",
  HATE: "Hateful or discriminatory",
  HARASSMENT: "Harassment or bullying",
  VIOLENCE: "Violent or threatening",
  SCAM_OR_PAYMENT: "Scam, or asks for real payment",
  PERSONAL_INFO: "Shows someone's personal information",
  IMPERSONATION: "Pretends to be a real person or company",
  COPYRIGHT: "Copies someone else's work",
  OTHER: "Something else",
};

export function reasonLabel(code: string): string {
  return REPORT_REASON_LABEL[code] ?? code;
}

const SAFETY_ERRORS: Record<string, string> = {
  REPORT_LIMIT: "You have sent as many reports as are allowed for now. Please try again in an hour.",
  ALREADY_REPORTED: "You have already reported this. We are looking at it.",
  APPEAL_EXISTS: "You have already appealed this decision. The status is on the Appeals page.",
  NOT_APPEALABLE: "This listing cannot be appealed right now.",
  COUPON_LIMIT: "You already have 5 active coupons, the most allowed. Pause or end one first.",
  RATE_LIMITED: "Too many tries in a short time. Wait a moment, then try again.",
  FORBIDDEN: "You do not have access to that.",
  SELF_REPORT: "You cannot report your own shop or listing.",
};

/** Plain words for the errors of reports, blocks, appeals and coupons. */
export function merchantErrorText(error: unknown): string {
  if (error instanceof ApiError && SAFETY_ERRORS[error.code]) return SAFETY_ERRORS[error.code] as string;
  return studioErrorText(error);
}

/** "+₹500 (+25%) vs the previous 7 days", or "No prior baseline" when there was nothing before. */
export function changeText(current: bigint, previous: bigint, days: number): string {
  const delta = current - previous;
  const versus = `vs the previous ${days} days`;
  if (previous === 0n) {
    return current === 0n
      ? `No change ${versus}. No prior baseline.`
      : `${signed(delta)} ${versus}. No prior baseline.`;
  }
  if (delta === 0n) return `No change ${versus}`;
  const percent = (delta * 100n) / previous;
  return `${signed(delta)} (${percent > 0n ? "+" : percent < 0n ? "−" : ""}${(percent < 0n ? -percent : percent).toString()}%) ${versus}`;
}

function signed(delta: bigint): string {
  return delta > 0n ? `+${formatInrExact(delta)}` : delta < 0n ? formatInrExact(delta) : formatInrExact(0n);
}

/** Like changeText for a count of orders. */
export function countChangeText(current: number, previous: number, days: number): string {
  const delta = current - previous;
  const versus = `vs the previous ${days} days`;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const abs = Math.abs(delta);
  if (previous === 0) return `${delta === 0 ? "No change" : `${sign}${abs}`} ${versus}. No prior baseline.`;
  if (delta === 0) return `No change ${versus}`;
  return `${sign}${abs} (${sign}${Math.trunc((abs * 100) / previous)}%) ${versus}`;
}

/** "Anonymous player" and nothing else: the portal never shows who bought. */
export const ANONYMOUS_BUYER = "Anonymous player";

export function sourceLabel(source: "PLAYER" | "STAFF"): string {
  return source === "STAFF" ? "Staff order" : "Player order";
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/** A coupon's terms as short plain phrases: "10% off", "Minimum spend ₹1,000", "First 50 uses". */
export function describeCoupon(c: CouponTerms): string[] {
  const out: string[] = [];
  if (c.kind === "PERCENT") out.push(`${c.percent ?? 0}% off`);
  else out.push(`${formatInrExact(c.amountPaise === null ? 0n : parsePaise(c.amountPaise))} off`);
  const min = parsePaise(c.minSpendPaise);
  if (min > 0n) out.push(`Minimum spend ${formatInrExact(min)}`);
  if (c.startsAt) out.push(`From ${dateText(c.startsAt)}`);
  if (c.endsAt) out.push(`Until ${dateText(c.endsAt)}`);
  if (c.maxRedemptions !== null) out.push(`First ${c.maxRedemptions} uses`);
  return out;
}
