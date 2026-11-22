"use client";

import { formatInrExact } from "@delulu/core";
import {
  DateRangePicker,
  FictionLabel,
  FormField,
  FunnelChart,
  LineChart,
  Price,
  Select,
  TrendStatGrid,
} from "@delulu/ui";
import { useMemo } from "react";
import { parsePaise, parsePaiseOrNull } from "../../../_lib/money";
import { formatDay, formatStamp, queryString, shortDay } from "../_lib/range";
import {
  type FunnelResponse,
  isMetric,
  METRICS,
  type Metric,
  type OverviewResponse,
  type TimeseriesResponse,
  type Totals,
} from "../_lib/types";
import { useAdminQuery } from "../_lib/use-admin-query";
import { useUrlState } from "../_lib/use-url-state";
import { AnalyticsFrame } from "./AnalyticsFrame";
import { Panel } from "./Panel";
import { PeriodNotes } from "./PeriodNotes";

const BASE = "/api/v1/admin/analytics";
const FUNNEL_LABELS = {
  visitors: "Visitors",
  product_views: "Product views",
  cart_adds: "Cart adds",
  checkout_starts: "Checkout starts",
  purchases: "Purchases",
} as const;

const count = (n: number) => n.toLocaleString("en-IN");
const money = (paise: string | null) =>
  paise === null ? (
    "No orders"
  ) : (
    <Price amountPaise={parsePaise(paise)} display="exact" className="font-display text-2xl font-bold" />
  );
const moneyPrev = (paise: string | null) =>
  paise === null ? undefined : (
    <Price amountPaise={parsePaise(paise)} display="exact" className="text-sm font-normal" />
  );

function stats(current: Totals, previous: Totals) {
  const n = (key: string, label: string, c: number, p: number) => ({
    key,
    label,
    value: count(c),
    current: BigInt(c),
    previous: BigInt(p),
    previousValue: count(p),
  });
  return [
    n("visitors", "Daily visitors (summed)", current.visitors, previous.visitors),
    n("signUps", "Sign-ups", current.signUps, previous.signUps),
    n("orders", "Orders", current.orders, previous.orders),
    {
      key: "spend",
      label: "Spend (fictional money)",
      value: money(current.spendPaise),
      current: parsePaise(current.spendPaise),
      previous: parsePaise(previous.spendPaise),
      previousValue: moneyPrev(previous.spendPaise),
    },
    {
      key: "aov",
      label: "Average order value (fictional money)",
      value: money(current.averageOrderValuePaise),
      current: parsePaiseOrNull(current.averageOrderValuePaise),
      previous: parsePaiseOrNull(previous.averageOrderValuePaise),
      previousValue: moneyPrev(previous.averageOrderValuePaise),
    },
    n("unlocks", "Creator unlocks", current.creatorUnlocks, previous.creatorUnlocks),
    n("shops", "Shops registered", current.shopsRegistered, previous.shopsRegistered),
    n("listings", "Listings published", current.listingsPublished, previous.listingsPublished),
  ];
}

/** /console/analytics: totals against the previous period, a metric over time, and the funnel. */
export function OverviewScreen() {
  const { params, range, today, go } = useUrlState();
  const metric: Metric = isMetric(params.get("metric")) ? (params.get("metric") as Metric) : "visitors";
  const rangeQs = queryString({ from: range.from, to: range.to });
  const [overview, retryOverview] = useAdminQuery<OverviewResponse>(`${BASE}/overview?${rangeQs}`);
  const [series, retrySeries] = useAdminQuery<TimeseriesResponse>(
    `${BASE}/timeseries?${queryString({ metric, from: range.from, to: range.to })}`,
  );
  const [funnel, retryFunnel] = useAdminQuery<FunnelResponse>(`${BASE}/funnel?${rangeQs}`);

  const rows = useMemo(
    () =>
      series.status === "ready"
        ? series.data.points.map((p) => ({
            date: p.day,
            label: shortDay(p.day),
            value: p.value === null ? null : parsePaise(p.value),
          }))
        : [],
    [series],
  );
  const metricLabel = METRICS.find((m) => m.value === metric)?.label ?? metric;
  const isMoney = series.status === "ready" && series.data.unit === "paise";

  return (
    <AnalyticsFrame current="/console/analytics" title="Analytics" states={[overview, series, funnel]}>
      <DateRangePicker
        today={today}
        from={range.from}
        to={range.to}
        onChange={(next) =>
          go({ from: next.from, to: next.to, metric: metric === "visitors" ? null : metric })
        }
      />
      <Panel
        title="Totals"
        hint={
          <>
            Visitors are daily visitors, summed over the period; the same person on two days counts twice.{" "}
            <FictionLabel>Fictional money</FictionLabel>
          </>
        }
        state={overview}
        retry={retryOverview}
        isEmpty={() => false}
      >
        {(data) => (
          <div className="flex flex-col gap-3">
            <PeriodNotes
              from={data.from}
              to={data.to}
              days={data.days}
              trafficDays={data.current.trafficDays}
              asOf={data.asOf}
              extra={`Compared with ${formatDay(data.previousFrom)} to ${formatDay(data.previousTo)}.${
                data.trafficComputedAt ? ` Traffic rolled up ${formatStamp(data.trafficComputedAt)}.` : ""
              }`}
            />
            <TrendStatGrid aria-label="Totals for the period" stats={stats(data.current, data.previous)} />
          </div>
        )}
      </Panel>
      <Panel
        title="Over time"
        state={series}
        retry={retrySeries}
        isEmpty={(data) => data.points.every((p) => p.value === null)}
        controls={
          <FormField label="Metric">
            {(control) => (
              <Select
                {...control}
                value={metric}
                onChange={(event) =>
                  go({ from: range.from, to: range.to, metric: event.target.value }, "replace")
                }
                className="max-w-xs"
              >
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        }
        hint={
          <>
            One point per UTC day.
            {series.status === "ready" && series.data.source === "events"
              ? " Days not yet rolled up are gaps, not zero."
              : ""}
          </>
        }
      >
        {() => (
          <LineChart
            caption={`${metricLabel} per day`}
            valueLabel={metricLabel}
            rows={rows}
            formatValue={(v) => (isMoney ? formatInrExact(v) : v.toLocaleString("en-IN"))}
          />
        )}
      </Panel>
      <Panel
        title="Funnel"
        hint="Daily visitors (summed) who reached each step; the last step counts purchases, so a visitor who buys twice counts twice."
        state={funnel}
        retry={retryFunnel}
        isEmpty={(data) => data.steps.every((s) => s.visitors === 0)}
      >
        {(data) => (
          <FunnelChart
            caption="Visitors to purchases"
            overallConversion={data.overallConversion}
            steps={data.steps.map((s) => ({
              key: s.step,
              label: FUNNEL_LABELS[s.step],
              visitors: s.visitors,
              conversionFromPrevious: s.conversionFromPrevious,
            }))}
          />
        )}
      </Panel>
    </AnalyticsFrame>
  );
}
