"use client";

import { Alert, DataTable, EarningsChart, Heading, Price, Select, StatGrid, Text } from "@delulu/ui";
import { useState } from "react";
import { changeText, countChangeText, type Earnings, type EarningsTotals } from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

const PERIODS = [7, 30, 90] as const;

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** /studio/earnings: one period against the one before, a daily chart with its table, top products, staff apart. */
export function StudioEarnings() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(7);
  const loaded = useApiGet<Earnings>(`/api/v1/studio/earnings?days=${days}`);
  return (
    <div className="flex flex-col gap-6">
      <PortalTitle>Earnings</PortalTitle>
      <div className="max-w-xs">
        <label htmlFor="period" className="mb-1 block text-sm font-medium text-fg">
          Period
        </label>
        <Select
          id="period"
          value={days}
          onChange={(e) => setDays(Number(e.target.value) as (typeof PERIODS)[number])}
        >
          {PERIODS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
      </div>
      {loaded.status === "loading" ? <LoadingBlock rows={4} label="Loading your earnings" /> : null}
      {loaded.status === "error" ? <ErrorBlock message={loaded.message} onRetry={loaded.reload} /> : null}
      {loaded.status === "ready" ? <Body e={loaded.data} /> : null}
    </div>
  );
}

function Body({ e }: { e: Earnings }) {
  const c = e.current;
  const p = e.previous;
  const money = (v: string) => <Price amountPaise={parsePaise(v)} display="exact" />;
  const asOf = new Date(e.asOf).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: e.timeZone,
  });
  return (
    <>
      <Text size="sm" muted data-testid="earnings-asof">
        Days run in the {e.timeZone} time zone. As of {asOf}. Player orders only.
      </Text>
      <section aria-labelledby="er-summary" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="er-summary">
          Last {e.periodDays} days compared with the {e.periodDays} before
        </Heading>
        <StatGrid
          aria-label={`Last ${e.periodDays} days`}
          data-testid="earnings-stats"
          stats={[
            {
              label: "Completed player orders",
              value: String(c.orders),
              change: countChangeText(c.orders, p.orders, e.periodDays),
            },
            {
              label: "Gross sales",
              value: money(c.grossPaise),
              change: changeText(parsePaise(c.grossPaise), parsePaise(p.grossPaise), e.periodDays),
            },
            {
              label: "Marketplace fees",
              value: money(c.feesPaise),
              change: changeText(parsePaise(c.feesPaise), parsePaise(p.feesPaise), e.periodDays),
            },
            {
              label: "Delivery you paid",
              value: money(c.merchantDeliveryPaise),
              change: changeText(
                parsePaise(c.merchantDeliveryPaise),
                parsePaise(p.merchantDeliveryPaise),
                e.periodDays,
              ),
            },
            {
              label: "Net earnings",
              value: money(c.netPaise),
              change: changeText(parsePaise(c.netPaise), parsePaise(p.netPaise), e.periodDays),
            },
            {
              label: "Different buyers",
              value: String(c.distinctBuyers),
              change: countChangeText(c.distinctBuyers, p.distinctBuyers, e.periodDays),
            },
            {
              label: "Average order",
              value: c.averageOrderPaise === null ? "No orders" : money(c.averageOrderPaise),
            },
          ]}
        />
      </section>

      <section aria-labelledby="er-chart" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="er-chart">
          Day by day
        </Heading>
        <EarningsChart
          caption={`Daily gross and net, last ${e.periodDays} days`}
          rows={e.daily.map((d) => ({
            date: d.date,
            label: dayLabel(d.date),
            orders: d.orders,
            grossPaise: parsePaise(d.grossPaise),
            netPaise: parsePaise(d.netPaise),
          }))}
        />
      </section>

      <section aria-labelledby="er-top" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="er-top">
          Top products
        </Heading>
        <DataTable
          caption="Top five products by gross sales"
          emptyTitle="No sales in this period"
          rows={e.topProducts.slice(0, 5)}
          rowKey={(t) => t.productId}
          columns={[
            { key: "name", header: "Product", cell: (t) => <span className="break-words">{t.name}</span> },
            { key: "units", header: "Units", align: "right", cell: (t) => t.units },
            {
              key: "gross",
              header: "Gross",
              align: "right",
              cell: (t) => <Price amountPaise={parsePaise(t.grossPaise)} display="exact" />,
            },
          ]}
        />
      </section>

      <StaffSection current={e.staff.current} previous={e.staff.previous} days={e.periodDays} />

      <Alert tone="info" title="Net earnings are not your bank balance">
        This page adds up what your orders earned. Your balance also moves for other reasons. See the{" "}
        <a href="/account/wallet" className="inline-flex min-h-touch items-center text-action underline">
          wallet statement
        </a>{" "}
        for every movement.
      </Alert>
    </>
  );
}

function StaffSection({
  current,
  previous,
  days,
}: {
  current: EarningsTotals;
  previous: EarningsTotals;
  days: number;
}) {
  return (
    <section
      aria-labelledby="er-staff"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id="er-staff">
        Staff orders (separate)
      </Heading>
      <Text size="sm" muted>
        Orders placed by DeluluMart staff for testing. They are never added to the player totals above.
      </Text>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="text-fg-muted">Staff orders, last {days} days</dt>
        <dd>
          {current.orders} ({previous.orders} in the {days} days before)
        </dd>
        <dt className="text-fg-muted">Staff gross</dt>
        <dd>
          <Price amountPaise={parsePaise(current.grossPaise)} display="exact" />
        </dd>
        <dt className="text-fg-muted">Staff net</dt>
        <dd>
          <Price amountPaise={parsePaise(current.netPaise)} display="exact" />
        </dd>
      </dl>
    </section>
  );
}
