import { DomainError } from "../errors/index";
import type { Paise } from "../money/index";

/**
 * Analytics catalogue shared by the web server, the browser helper and the database tests (PRD R7.1,
 * R16.5; architecture §9.6, §18.2). Pure functions only. Events carry no identity, no address, no
 * user agent, no search text and no exact amount: only the labels and buckets defined here. The
 * database (migration 0052) enforces the same allow-lists, so a caller that skips this module is
 * still refused there.
 */

/** Browser-originated events: the only names POST /api/v1/events accepts. */
export const BROWSER_EVENT_NAMES = [
  "page_view",
  "search",
  "product_view",
  "cart_add",
  "checkout_start",
] as const;
/** Server-recorded events, written after the command succeeded; never accepted from a browser. */
export const SERVER_EVENT_NAMES = [
  "purchase",
  "sign_up",
  "creator_unlock",
  "shop_registered",
  "listing_published",
  // ratings and reviews (migration 0078): no props, no user id, no text
  "review_submitted",
  "review_hidden",
  // Super Admin configuration change (migration 0090): written by the database when a delayed
  // action runs; no props, no user id, no values
  "console_config_changed",
  // DeluluPay (PRD R10, migration 0103): recorded by the server after the step succeeded, one prop
  // (`method`), no user id, no code, no amount
  "payment_method_selected",
  "payment_challenge_issued",
  "payment_challenge_passed",
  "payment_challenge_failed",
] as const;
export const ANALYTICS_EVENT_NAMES = [...BROWSER_EVENT_NAMES, ...SERVER_EVENT_NAMES] as const;

export type BrowserEventName = (typeof BROWSER_EVENT_NAMES)[number];
export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const SURFACES = ["shop", "account", "checkout", "studio", "console"] as const;
export type Surface = (typeof SURFACES)[number];

export const DEVICE_CLASSES = ["mobile", "tablet", "desktop", "unknown"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** Bucket labels (the database's props allow-list uses the same strings). */
export const RESULT_COUNT_BUCKETS = ["0", "1-5", "6-20", "21+"] as const;
export const QUERY_LENGTH_BUCKETS = ["0", "1-3", "4-10", "11-30", "31+"] as const;
export const AMOUNT_BUCKETS = ["lt_1k", "1k_10k", "10k_1l", "1l_10l", "10l_1cr", "1cr_plus"] as const;
export type ResultCountBucket = (typeof RESULT_COUNT_BUCKETS)[number];
export type QueryLengthBucket = (typeof QUERY_LENGTH_BUCKETS)[number];
export type AmountBucket = (typeof AMOUNT_BUCKETS)[number];

/** Bucket edges: the upper bound (inclusive) of each bucket but the last. */
const RESULT_COUNT_EDGES = [0, 5, 20] as const;
const QUERY_LENGTH_EDGES = [0, 3, 10, 30] as const;
/** In paise: ₹1k, ₹10k, ₹1 lakh, ₹10 lakh, ₹1 crore (each the first value of the next bucket). */
const AMOUNT_EDGES_PAISE = [100_000n, 1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n] as const;

/** The largest item count an event may carry. */
export const ITEM_COUNT_MAX = 100;
/** Longest region or city label kept. */
export const PLACE_LABEL_MAX = 64;
/** Longest date range an analytics read accepts (one leap year). */
export const RANGE_MAX_DAYS = 366;
/** The country code of an unresolvable place. */
export const UNKNOWN_COUNTRY = "ZZ";

function bucketBy<T extends string>(n: number, edges: readonly number[], labels: readonly T[]): T {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const i = edges.findIndex((edge) => v <= edge);
  return labels[i === -1 ? labels.length - 1 : i] as T;
}

export function resultCountBucket(count: number): ResultCountBucket {
  return bucketBy(count, RESULT_COUNT_EDGES, RESULT_COUNT_BUCKETS);
}

export function queryLengthBucket(length: number): QueryLengthBucket {
  return bucketBy(length, QUERY_LENGTH_EDGES, QUERY_LENGTH_BUCKETS);
}

export function amountBucket(paise: Paise): AmountBucket {
  if (paise < 0n) throw new DomainError("VALIDATION_FAILED", "an amount is never negative");
  const i = AMOUNT_EDGES_PAISE.findIndex((edge) => paise < edge);
  return AMOUNT_BUCKETS[i === -1 ? AMOUNT_BUCKETS.length - 1 : i] as AmountBucket;
}

export function itemCount(n: number): number {
  return Math.min(ITEM_COUNT_MAX, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 1));
}

/** The class of device only; the user agent itself is never kept. */
export function deviceClassOf(userAgent: string | null | undefined): DeviceClass {
  const ua = (userAgent ?? "").slice(0, 512);
  if (ua === "") return "unknown";
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua)) return "tablet";
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry/i.test(ua)) return "mobile";
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return "desktop";
  return "unknown";
}

export interface Place {
  /** ISO 3166-1 alpha-2, or "ZZ" when unknown. */
  country: string;
  /** State or province (a subdivision code from the edge), or null. */
  region: string | null;
  city: string | null;
}

/** Letters and marks of any script, digits, space and . , ' ( ) - only: no separators or markup. */
const LABEL = /^[\p{L}\p{M}\p{N} .,'()-]+$/u;
/** ISO 3166-2 subdivision code part, as the edge sends it (x-vercel-ip-country-region). */
const REGION_CODE = /^[A-Z0-9]{1,3}$/;
/**
 * A city (eighth review, minor 5): letters and marks of any script, space, apostrophe, hyphen and
 * dot only; no digit, symbol or punctuation. The database's analytics.city_ok is the same rule.
 */
const CITY = /^[\p{L}\p{M} .'-]+$/u;
/** Letter-like symbols and blocks the database refuses as well (Latin-1 signs, symbols, emoji). */
const CITY_EXCLUDED =
  /[\u0080-\u00BF\u00D7\u00F7\u2010-\u2BFF\u3000-\u303F\uFF00-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFFF\u{1D400}-\u{1D7FF}\u{1F000}-\u{1FFFF}]/u;

function decodeLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.length > PLACE_LABEL_MAX * 12) return null; // a percent-encoded label is at most 9 bytes a char
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const label = decoded.normalize("NFC").trim().replace(/ {2,}/g, " ");
  if (label === "" || label.length > PLACE_LABEL_MAX || !LABEL.test(label)) return null;
  return label;
}

/** A region code (upper case), or null for anything else. */
function regionOf(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  return REGION_CODE.test(code) ? code : null;
}

function cityOf(raw: string | null | undefined): string | null {
  const label = decodeLabel(raw);
  return label !== null && CITY.test(label) && !CITY_EXCLUDED.test(label) ? label : null;
}

/**
 * Validates the hosting edge's approximate place of a request (R7.1). The region is a subdivision
 * code only and the city a name of letters only; anything else is dropped. An unknown country drops
 * the region and city too.
 */
export function parsePlace(raw: {
  country: string | null | undefined;
  region: string | null | undefined;
  city: string | null | undefined;
}): Place {
  const country = (raw.country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || country === UNKNOWN_COUNTRY) {
    return { country: UNKNOWN_COUNTRY, region: null, city: null };
  }
  return { country, region: regionOf(raw.region), city: cityOf(raw.city) };
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function dayNumber(value: string): number | null {
  const m = DAY.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // round trip: refuses 2026-02-30 and friends
  if (new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms / MS_PER_DAY;
}

/** A closed range of UTC days, from <= to, at most RANGE_MAX_DAYS long. */
export function validateDateRange(
  from: string,
  to: string,
  maxDays: number = RANGE_MAX_DAYS,
): { from: string; to: string; days: number } {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) {
    throw new DomainError("VALIDATION_FAILED", "dates are YYYY-MM-DD", { field: a === null ? "from" : "to" });
  }
  if (a > b) throw new DomainError("VALIDATION_FAILED", "from is on or before to", { field: "from" });
  const days = b - a + 1;
  if (days > maxDays) {
    throw new DomainError("VALIDATION_FAILED", `a range is at most ${maxDays} days`, { field: "to" });
  }
  return { from, to, days };
}
