import "./server-only";
import { serializePaise, validateDateRange } from "@delulu/core";
import {
  type AnalyticsFunnel,
  type AnalyticsOverview,
  type AnalyticsPlaces,
  type AnalyticsTimeseries,
  type AnalyticsTop,
  type PeriodTotals,
  TIMESERIES_METRICS,
  type TopItem,
} from "@delulu/db/runtime";
import { z } from "zod";
import { SERVER_CONFIG } from "./config";

/**
 * Query shapes and JSON views of the Super Admin analytics reads (GET /api/v1/admin/analytics/*).
 * Money is a decimal string of paise; times are ISO strings; days are YYYY-MM-DD (UTC). Every
 * figure is an aggregate: no row names a player.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** from and to, inclusive UTC days: from <= to, at most 366 days (checked again by the database). */
export const rangeQuery = z
  .strictObject({ from: day, to: day })
  .transform((q) => validateDateRange(q.from, q.to));

export const timeseriesQuery = z
  .strictObject({ metric: z.enum(TIMESERIES_METRICS), from: day, to: day })
  .transform((q) => ({ metric: q.metric, ...validateDateRange(q.from, q.to) }));

const placeLabel = z.string().min(1).max(64);
export const placesQuery = z
  .strictObject({
    level: z.enum(["country", "region", "city"]),
    country: z
      .string()
      .regex(/^([A-Za-z]{2}|Other)$/)
      .transform((c) => (c === "Other" ? c : c.toUpperCase()))
      .optional(),
    region: placeLabel.optional(),
    from: day,
    to: day,
  })
  .transform((q) => ({
    level: q.level,
    country: q.country ?? null,
    region: q.region ?? null,
    ...validateDateRange(q.from, q.to),
  }));

export const topQuery = z
  .strictObject({
    kind: z.enum(["product", "company", "category"]),
    from: day,
    to: day,
    limit: z
      .string()
      .regex(/^\d{1,2}$/)
      .transform(Number)
      .refine((n) => n >= 1 && n <= SERVER_CONFIG.analytics.topMaxLimit)
      .optional(),
  })
  .transform((q) => ({
    kind: q.kind,
    limit: q.limit ?? SERVER_CONFIG.analytics.topDefaultLimit,
    ...validateDateRange(q.from, q.to),
  }));

const iso = (d: Date) => d.toISOString();

function totalsView(t: PeriodTotals) {
  return {
    visitors: t.visitors,
    trafficDays: t.trafficDays,
    signUps: t.signUps,
    orders: t.orders,
    spendPaise: serializePaise(t.spendPaise),
    averageOrderValuePaise:
      t.averageOrderValuePaise === null ? null : serializePaise(t.averageOrderValuePaise),
    creatorUnlocks: t.creatorUnlocks,
    shopsRegistered: t.shopsRegistered,
    listingsPublished: t.listingsPublished,
  };
}

export function overviewView(o: AnalyticsOverview) {
  return {
    from: o.from,
    to: o.to,
    days: o.days,
    previousFrom: o.previousFrom,
    previousTo: o.previousTo,
    current: totalsView(o.current),
    previous: totalsView(o.previous),
    asOf: iso(o.asOf),
    trafficComputedAt: o.trafficComputedAt === null ? null : iso(o.trafficComputedAt),
  };
}

export function timeseriesView(t: AnalyticsTimeseries) {
  return {
    metric: t.metric,
    from: t.from,
    to: t.to,
    days: t.days,
    unit: t.unit,
    source: t.source,
    points: t.points.map((p) => ({ day: p.day, value: p.value === null ? null : p.value.toString() })),
    asOf: iso(t.asOf),
  };
}

export function funnelView(f: AnalyticsFunnel) {
  return {
    from: f.from,
    to: f.to,
    days: f.days,
    steps: f.steps.map((s) => ({
      step: s.step,
      visitors: s.visitors,
      conversionFromPrevious: s.conversionFromPrevious,
    })),
    overallConversion: f.overallConversion,
    trafficDays: f.trafficDays,
    asOf: iso(f.asOf),
  };
}

export function placesView(p: AnalyticsPlaces) {
  return {
    level: p.level,
    country: p.country,
    region: p.region,
    from: p.from,
    to: p.to,
    days: p.days,
    minVisitors: p.minVisitors,
    items: p.items.map((i) => ({
      country: i.country,
      region: i.region,
      city: i.city,
      visitors: i.visitors,
      signUps: i.signUps,
      purchases: i.purchases,
      suppressed: i.suppressed,
    })),
    trafficDays: p.trafficDays,
    asOf: iso(p.asOf),
  };
}

function topItemView(kind: AnalyticsTop["kind"], i: TopItem) {
  const totals = { orders: i.orders, units: i.units, spendPaise: serializePaise(i.spendPaise) };
  if (kind === "product") {
    return {
      productId: i.productId ?? null,
      name: i.name ?? null,
      category: i.category ?? null,
      shop: i.shop ?? null,
      ...totals,
    };
  }
  if (kind === "company") return { companyId: i.companyId ?? null, shop: i.shop ?? null, ...totals };
  return { category: i.category ?? null, ...totals };
}

export function topView(t: AnalyticsTop) {
  return {
    kind: t.kind,
    from: t.from,
    to: t.to,
    days: t.days,
    limit: t.limit,
    items: t.items.map((i) => topItemView(t.kind, i)),
    asOf: iso(t.asOf),
  };
}
