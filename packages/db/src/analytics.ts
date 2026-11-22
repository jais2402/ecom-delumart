/**
 * The analytics engine's database calls (migrations 0052, 0061). Events are written only through
 * analytics.record_event as app_web, for the caller's session when there is one (the database
 * derives whether the request is signed in, and records nothing for a research opt-out or a test
 * account). The Super Admin's reads run as app_web for the admin's session; each function checks
 * the Super Admin itself and answers FORBIDDEN to anyone else. Money is returned as bigint paise.
 */
import type { Pool } from "pg";
import { asWeb, one } from "./command";

type Json = Record<string, unknown>;

export interface RecordEventInput {
  /** The request's sign-in session (cookie), or null for an anonymous request. Never stored. */
  authSessionId: string | null;
  name: string;
  surface: string;
  /**
   * Browser events: 16 bytes, the web server's keyed hash under the day's salt (never the address
   * or user agent). Server events (purchase, sign_up, creator_unlock, shop_registered): null (0061).
   */
  visitorKey: Uint8Array | null;
  /** Browser events: 8 bytes, the keyed hash of the address prefix only; server events: null. */
  placeKey: Uint8Array | null;
  country: string;
  region: string | null;
  city: string | null;
  deviceClass: string;
  props: Readonly<Record<string, string | number>>;
}

/** True when an event was stored; false when the actor opted out or the product is not on sale. */
export async function recordEvent(pool: Pool, input: RecordEventInput): Promise<boolean> {
  return asWeb(pool, input.authSessionId, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      "SELECT analytics.record_event($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) AS ok",
      [
        input.name,
        input.surface,
        input.visitorKey === null ? null : Buffer.from(input.visitorKey),
        input.placeKey === null ? null : Buffer.from(input.placeKey),
        input.country,
        input.region,
        input.city,
        input.deviceClass,
        JSON.stringify(input.props),
      ],
    );
    return rows[0]?.ok === true;
  });
}

/**
 * Today's (UTC, the database's clock) random analytics salt, created on first use (0061). Only
 * today's is ever returned; the purge job deletes old ones, so past keys cannot be recomputed.
 */
export async function todaySalt(pool: Pool): Promise<{ day: string; salt: Buffer }> {
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<{ day: string; salt: Buffer }>(
      "SELECT day::text AS day, salt FROM analytics.today_salt()",
    );
    const row = rows[0];
    if (!row) throw new Error("analytics.today_salt returned nothing");
    return { day: row.day, salt: row.salt };
  });
}

// ------------------------------------------------------------------ Super Admin reads

interface AdminRange {
  authSessionId: string;
  /** UTC days, YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
}

export interface PeriodTotals {
  /** Sum of daily unique visitors (the visitor key rotates daily). */
  visitors: number;
  /** Days of the period whose traffic has been rolled up. */
  trafficDays: number;
  signUps: number;
  orders: number;
  spendPaise: bigint;
  averageOrderValuePaise: bigint | null;
  creatorUnlocks: number;
  shopsRegistered: number;
  listingsPublished: number;
}

export interface AnalyticsOverview {
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  current: PeriodTotals;
  previous: PeriodTotals;
  asOf: Date;
  trafficComputedAt: Date | null;
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const big = (v: unknown): bigint => BigInt(String(v ?? "0"));
const bigOrNull = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function totalsOf(t: Json): PeriodTotals {
  return {
    visitors: num(t.visitors),
    trafficDays: num(t.trafficDays),
    signUps: num(t.signUps),
    orders: num(t.orders),
    spendPaise: big(t.spendPaise),
    averageOrderValuePaise: bigOrNull(t.averageOrderValuePaise),
    creatorUnlocks: num(t.creatorUnlocks),
    shopsRegistered: num(t.shopsRegistered),
    listingsPublished: num(t.listingsPublished),
  };
}

export async function analyticsOverview(pool: Pool, input: AdminRange): Promise<AnalyticsOverview> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT analytics.admin_overview($1::date, $2::date) AS r", [input.from, input.to]),
  );
  return {
    from: String(r.from),
    to: String(r.to),
    days: num(r.days),
    previousFrom: String(r.previousFrom),
    previousTo: String(r.previousTo),
    current: totalsOf(r.current as Json),
    previous: totalsOf(r.previous as Json),
    asOf: new Date(String(r.asOf)),
    trafficComputedAt: dateOrNull(r.trafficComputedAt),
  };
}

export const TIMESERIES_METRICS = [
  "visitors",
  "page_views",
  "searches",
  "product_views",
  "cart_adds",
  "checkout_starts",
  "sign_ups",
  "orders",
  "spend",
  "creator_unlocks",
  "shops_registered",
  "listings_published",
] as const;
export type TimeseriesMetric = (typeof TIMESERIES_METRICS)[number];

export interface AnalyticsTimeseries {
  metric: TimeseriesMetric;
  from: string;
  to: string;
  days: number;
  unit: "count" | "paise";
  /** "events": rolled-up traffic; "records": the real tables (orders, ledger, accounts...). */
  source: "events" | "records";
  /** One point per UTC day; null when the day's traffic has not been rolled up (unavailable). */
  points: { day: string; value: bigint | null }[];
  asOf: Date;
}

export async function analyticsTimeseries(
  pool: Pool,
  input: AdminRange & { metric: TimeseriesMetric },
): Promise<AnalyticsTimeseries> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT analytics.admin_timeseries($1, $2::date, $3::date) AS r", [
      input.metric,
      input.from,
      input.to,
    ]),
  );
  return {
    metric: r.metric as TimeseriesMetric,
    from: String(r.from),
    to: String(r.to),
    days: num(r.days),
    unit: r.unit === "paise" ? "paise" : "count",
    source: r.source === "records" ? "records" : "events",
    points: (r.points as Json[]).map((p) => ({ day: String(p.day), value: bigOrNull(p.value) })),
    asOf: new Date(String(r.asOf)),
  };
}

export const FUNNEL_STEPS = [
  "visitors",
  "product_views",
  "cart_adds",
  "checkout_starts",
  "purchases",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export interface AnalyticsFunnel {
  from: string;
  to: string;
  days: number;
  /**
   * Visitors who reached each step (sums of daily unique visitors); the purchases step counts
   * purchase events instead (`unit` "events"): a purchase carries no visitor key (0061).
   */
  steps: {
    step: FunnelStep;
    visitors: number;
    unit: "visitors" | "events";
    conversionFromPrevious: number | null;
  }[];
  overallConversion: number | null;
  trafficDays: number;
  asOf: Date;
}

export async function analyticsFunnel(pool: Pool, input: AdminRange): Promise<AnalyticsFunnel> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT analytics.admin_funnel($1::date, $2::date) AS r", [input.from, input.to]),
  );
  const ratio = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    from: String(r.from),
    to: String(r.to),
    days: num(r.days),
    steps: (r.steps as Json[]).map((s) => ({
      step: s.step as FunnelStep,
      visitors: num(s.visitors),
      unit: s.unit === "events" ? ("events" as const) : ("visitors" as const),
      conversionFromPrevious: ratio(s.conversionFromPrevious),
    })),
    overallConversion: ratio(r.overallConversion),
    trafficDays: num(r.trafficDays),
    asOf: new Date(String(r.asOf)),
  };
}

export type PlaceLevel = "country" | "region" | "city";

export interface PlaceRow {
  /** ISO-2, "ZZ" (unknown) or "Other" (places below the minimum count, folded). */
  country: string;
  /** Null at country level or when unknown; "Other" when folded. */
  region: string | null;
  city: string | null;
  /**
   * Null with `suppressed` for the one "Other" row that is still below the minimum after every
   * row under the minimum was merged into it (0059): the screen shows "Fewer than N".
   */
  visitors: number | null;
  /** Also null (without `suppressed`) when above 0 but below `minCellCount` (0061). */
  signUps: number | null;
  purchases: number | null;
  suppressed: boolean;
}

export interface AnalyticsPlaces {
  level: PlaceLevel;
  country: string | null;
  region: string | null;
  from: string;
  to: string;
  days: number;
  minVisitors: number;
  /** Sign-up and purchase cells between 1 and this minus one are returned null (0061). */
  minCellCount: number;
  items: PlaceRow[];
  trafficDays: number;
  asOf: Date;
}

export async function analyticsPlaces(
  pool: Pool,
  input: AdminRange & { level: PlaceLevel; country: string | null; region: string | null },
): Promise<AnalyticsPlaces> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT analytics.admin_places($1, $2, $3, $4::date, $5::date) AS r", [
      input.level,
      input.country,
      input.region,
      input.from,
      input.to,
    ]),
  );
  return {
    level: r.level as PlaceLevel,
    country: textOrNull(r.country),
    region: textOrNull(r.region),
    from: String(r.from),
    to: String(r.to),
    days: num(r.days),
    minVisitors: num(r.minVisitors),
    minCellCount: num(r.minCellCount),
    items: (r.items as Json[]).map((i) => ({
      country: String(i.country),
      region: textOrNull(i.region),
      city: textOrNull(i.city),
      visitors: numOrNull(i.visitors),
      signUps: numOrNull(i.signUps),
      purchases: numOrNull(i.purchases),
      suppressed: i.suppressed === true,
    })),
    trafficDays: num(r.trafficDays),
    asOf: new Date(String(r.asOf)),
  };
}

export type TopKind = "product" | "company" | "category";

export interface TopShop {
  name: string;
  handle: string | null;
}

export interface TopItem {
  /** kind product */
  productId?: string;
  name?: string | null;
  category?: string | null;
  /** kind product and company: null for DeluluMart Originals (platform seed items) */
  shop?: TopShop | null;
  /** kind company: null for DeluluMart Originals */
  companyId?: string | null;
  orders: number;
  units: number;
  spendPaise: bigint;
}

export interface AnalyticsTop {
  kind: TopKind;
  from: string;
  to: string;
  days: number;
  limit: number;
  items: TopItem[];
  asOf: Date;
}

export async function analyticsTop(
  pool: Pool,
  input: AdminRange & { kind: TopKind; limit: number },
): Promise<AnalyticsTop> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT analytics.admin_top($1, $2::date, $3::date, $4) AS r", [
      input.kind,
      input.from,
      input.to,
      input.limit,
    ]),
  );
  const shopOf = (v: unknown): TopShop | null => {
    if (v === null || v === undefined) return null;
    const s = v as Json;
    return { name: String(s.name), handle: textOrNull(s.handle) };
  };
  return {
    kind: r.kind as TopKind,
    from: String(r.from),
    to: String(r.to),
    days: num(r.days),
    limit: num(r.limit),
    items: (r.items as Json[]).map((i) => {
      const base = { orders: num(i.orders), units: num(i.units), spendPaise: big(i.spendPaise) };
      if (r.kind === "product") {
        return {
          productId: String(i.productId),
          name: textOrNull(i.name),
          category: textOrNull(i.category),
          shop: shopOf(i.shop),
          ...base,
        };
      }
      if (r.kind === "company") return { companyId: textOrNull(i.companyId), shop: shopOf(i.shop), ...base };
      return { category: textOrNull(i.category), ...base };
    }),
    asOf: new Date(String(r.asOf)),
  };
}
