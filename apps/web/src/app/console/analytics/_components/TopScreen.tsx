"use client";

import {
  type DataColumn,
  DataTable,
  DateRangePicker,
  FictionLabel,
  Price,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
} from "@delulu/ui";
import { parsePaise } from "../../../_lib/money";
import { categoryLabel } from "../../../_lib/studio";
import { queryString } from "../_lib/range";
import type { TopCategory, TopCompany, TopKind, TopProduct, TopResponse } from "../_lib/types";
import { useAdminQuery } from "../_lib/use-admin-query";
import { useUrlState } from "../_lib/use-url-state";
import { AnalyticsFrame } from "./AnalyticsFrame";
import { Panel } from "./Panel";
import { PeriodNotes } from "./PeriodNotes";

const PATH = "/console/analytics/top";
const TABS: { kind: TopKind; tab: string; title: string; noun: string }[] = [
  { kind: "product", tab: "Products", title: "Top products", noun: "Product" },
  { kind: "company", tab: "Shops", title: "Top shops", noun: "Shop" },
  { kind: "category", tab: "Categories", title: "Top categories", noun: "Category" },
];
const ORIGINALS = "DeluluMart Originals";

type Row = {
  rank: number;
  key: string;
  name: string;
  detail: string | null;
  orders: number;
  units: number;
  spendPaise: string;
};

const shopText = (shop: { name: string; handle: string } | null) => (shop ? shop.name : ORIGINALS);

function toRows(data: TopResponse): Row[] {
  return data.items.map((item, i) => {
    const base = { rank: i + 1, orders: item.orders, units: item.units, spendPaise: item.spendPaise };
    if (data.kind === "product") {
      const p = item as TopProduct;
      return {
        ...base,
        key: p.productId,
        name: p.name,
        detail: `${categoryLabel(p.category)} · ${shopText(p.shop)}`,
      };
    }
    if (data.kind === "company") {
      const c = item as TopCompany;
      return {
        ...base,
        key: c.companyId ?? "originals",
        name: shopText(c.shop),
        detail: c.shop ? `/store/${c.shop.handle}` : "Platform stock",
      };
    }
    const c = item as TopCategory;
    return { ...base, key: c.category, name: categoryLabel(c.category), detail: null };
  });
}

function columns(noun: string): DataColumn<Row>[] {
  return [
    { key: "rank", header: "Rank", cell: (r) => r.rank },
    {
      key: "name",
      header: noun,
      cell: (r) => (
        <div className="min-w-[10rem]">
          <p className="break-words font-medium">{r.name}</p>
          {r.detail ? <p className="break-words text-fg-muted">{r.detail}</p> : null}
        </div>
      ),
    },
    { key: "orders", header: "Orders", align: "right", cell: (r) => r.orders.toLocaleString("en-IN") },
    { key: "units", header: "Units", align: "right", cell: (r) => r.units.toLocaleString("en-IN") },
    {
      key: "spend",
      header: "Spend (fictional)",
      align: "right",
      cell: (r) => (
        <Price amountPaise={parsePaise(r.spendPaise)} display="exact" className="text-sm font-normal" />
      ),
    },
  ];
}

/** /console/analytics/top: ranked by fictional spend, then orders. The tab is in the URL. */
export function TopScreen() {
  const { params, range, today, go } = useUrlState();
  const asked = params.get("kind");
  const kind: TopKind = TABS.find((t) => t.kind === asked)?.kind ?? "product";
  const [state, retry] = useAdminQuery<TopResponse>(
    `/api/v1/admin/analytics/top?${queryString({ kind, from: range.from, to: range.to })}`,
  );
  const dates = { from: range.from, to: range.to };

  return (
    <AnalyticsFrame current={PATH} title="Top sellers" states={[state]}>
      <DateRangePicker
        today={today}
        from={range.from}
        to={range.to}
        onChange={(next) => go({ kind, from: next.from, to: next.to })}
      />
      <Tabs value={kind} onValueChange={(next) => go({ kind: next, ...dates }, "replace")}>
        <TabsList aria-label="Rank by">
          {TABS.map((t) => (
            <TabsTrigger key={t.kind} value={t.kind}>
              {t.tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.kind} value={t.kind} className="flex flex-col gap-3">
            <Panel
              title={t.title}
              hint="Ranked by spend, then orders, from completed player orders."
              state={t.kind === kind ? state : { status: "loading" }}
              retry={retry}
              isEmpty={(data) => data.items.length === 0}
            >
              {(data) => (
                <div className="flex flex-col gap-3">
                  <PeriodNotes
                    from={data.from}
                    to={data.to}
                    days={data.days}
                    trafficDays={data.days}
                    asOf={data.asOf}
                  />
                  <FictionLabel>Fictional money: every amount here is game money</FictionLabel>
                  <DataTable
                    caption={`${t.title}, by spend`}
                    columns={columns(t.noun)}
                    rows={toRows(data)}
                    rowKey={(r) => r.key}
                  />
                  <Text size="sm" muted>{`Showing up to ${data.limit}.`}</Text>
                </div>
              )}
            </Panel>
          </TabsContent>
        ))}
      </Tabs>
    </AnalyticsFrame>
  );
}
