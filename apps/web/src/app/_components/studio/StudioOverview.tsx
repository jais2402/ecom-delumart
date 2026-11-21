"use client";

import { formatInrCompact } from "@delulu/core";
import { Alert, Badge, EmptyState, Heading, Price, ProgressBar, StatGrid, Text } from "@delulu/ui";
import {
  type AppealRow,
  type BrandProgress,
  changeText,
  countChangeText,
  type Earnings,
  type InventoryResponse,
} from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import type { ListingPage } from "../../_lib/studio";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

const DAYS = 7;

/** /studio/overview: seven days against the seven before, brand progress, and what needs doing. */
export function StudioOverview() {
  const earnings = useApiGet<Earnings>(`/api/v1/studio/earnings?days=${DAYS}`);
  return (
    <div className="flex flex-col gap-6">
      <PortalTitle>Overview</PortalTitle>
      {earnings.status === "loading" ? <LoadingBlock rows={3} label="Loading your numbers" /> : null}
      {earnings.status === "error" ? (
        <ErrorBlock message={earnings.message} onRetry={earnings.reload} />
      ) : null}
      {earnings.status === "ready" ? <Numbers e={earnings.data} /> : null}
      <BrandPanel />
      <ActionList />
    </div>
  );
}

function Numbers({ e }: { e: Earnings }) {
  const c = e.current;
  const p = e.previous;
  const money = (v: string) => <Price amountPaise={parsePaise(v)} display="exact" />;
  const stats = [
    {
      label: "Completed player orders",
      value: String(c.orders),
      change: countChangeText(c.orders, p.orders, DAYS),
    },
    {
      label: "Gross sales",
      value: money(c.grossPaise),
      change: changeText(parsePaise(c.grossPaise), parsePaise(p.grossPaise), DAYS),
    },
    {
      label: "Marketplace fees",
      value: money(c.feesPaise),
      change: changeText(parsePaise(c.feesPaise), parsePaise(p.feesPaise), DAYS),
    },
    {
      label: "Net earnings",
      value: money(c.netPaise),
      change: changeText(parsePaise(c.netPaise), parsePaise(p.netPaise), DAYS),
    },
  ];
  const quiet = c.orders === 0 && p.orders === 0;
  return (
    <section aria-labelledby="ov-week" className="flex flex-col gap-3">
      <Heading level={2} size="sm" id="ov-week">
        Last {DAYS} days
      </Heading>
      <StatGrid stats={stats} aria-label="Last 7 days" data-testid="overview-stats" />
      <Text size="sm" muted>
        Player orders only. Staff orders are on the Earnings page. As of{" "}
        {new Date(e.asOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} ({e.timeZone}
        ).
      </Text>
      {quiet ? (
        <EmptyState title="No player purchases yet. Share your shop or keep building." headingLevel={3} />
      ) : null}
    </section>
  );
}

function BrandPanel() {
  const loaded = useApiGet<BrandProgress>("/api/v1/studio/brand-progress");
  if (loaded.status === "loading") return <LoadingBlock rows={1} label="Loading brand progress" />;
  if (loaded.status === "error") return <ErrorBlock message={loaded.message} onRetry={loaded.reload} />;
  const b = loaded.data;
  const gross = parsePaise(b.qualifyingGrossPaise);
  const threshold = parsePaise(b.thresholdPaise);
  const grossPercent = threshold > 0n ? Number((gross * 100n) / threshold) : 0;
  return (
    <section
      aria-labelledby="ov-brand"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={2} size="sm" id="ov-brand">
          Brand progress
        </Heading>
        {b.brandUnlocked ? <Badge tone="success">Unlocked</Badge> : <Badge tone="neutral">Locked</Badge>}
      </div>
      <p>
        {formatInrCompact(gross)} of {formatInrCompact(threshold)} eligible player revenue
      </p>
      <ProgressBar
        label="Eligible player revenue towards the brand tier"
        value={Math.min(grossPercent, 100)}
        max={100}
      />
      <p>
        {b.eligibleBuyers} of {b.minBuyers} eligible buyers
      </p>
      <ProgressBar
        label="Eligible buyers towards the brand tier"
        value={Math.min(b.eligibleBuyers, b.minBuyers)}
        max={b.minBuyers}
      />
      <Text size="sm" muted>
        {b.brandUnlocked
          ? "Your shop has the brand tier."
          : "The brand tier is locked until both targets are met."}{" "}
        Buyers count after their account is {b.buyerMinAgeHours} hours old. Team features come later.
      </Text>
    </section>
  );
}

function ActionList() {
  const listings = useApiGet<ListingPage>("/api/v1/studio/products?limit=50");
  const inventory = useApiGet<InventoryResponse>("/api/v1/studio/inventory");
  const appeals = useApiGet<{ items: AppealRow[] }>("/api/v1/studio/appeals");
  const items: { key: string; text: string; href: string; cta: string }[] = [];
  if (listings.status === "ready") {
    const drafts = listings.data.items.filter((l) => l.status === "DRAFT").length;
    const rejected = listings.data.items.filter((l) => l.status === "REJECTED").length;
    if (drafts > 0)
      items.push({
        key: "drafts",
        text: `${drafts} ${drafts === 1 ? "draft" : "drafts"} not submitted`,
        href: "/studio/products",
        cta: "Open products",
      });
    if (rejected > 0)
      items.push({
        key: "rejected",
        text: `${rejected} rejected ${rejected === 1 ? "listing" : "listings"}`,
        href: "/studio/products",
        cta: "Open products",
      });
  }
  if (inventory.status === "ready") {
    const low = inventory.data.products.filter((p) => p.lowStock).length;
    if (low > 0)
      items.push({
        key: "low",
        text: `${low} ${low === 1 ? "product" : "products"} low on stock`,
        href: "/studio/inventory",
        cta: "Open inventory",
      });
  }
  if (appeals.status === "ready") {
    const open = appeals.data.items.filter((a) => a.status === "OPEN").length;
    if (open > 0)
      items.push({
        key: "appeals",
        text: `${open} open ${open === 1 ? "appeal" : "appeals"}`,
        href: "/studio/appeals",
        cta: "Open appeals",
      });
  }
  const loading = [listings, inventory, appeals].some((l) => l.status === "loading");
  const failed = [listings, inventory, appeals].some((l) => l.status === "error");
  return (
    <section aria-labelledby="ov-actions" className="flex flex-col gap-3">
      <Heading level={2} size="sm" id="ov-actions">
        Needs your attention
      </Heading>
      {loading ? <LoadingBlock rows={1} label="Loading your to-do list" /> : null}
      {!loading && items.length === 0 && !failed ? (
        <Text muted>Nothing needs your attention right now.</Text>
      ) : null}
      {failed ? (
        <Alert tone="warning">Some of this list could not load. Reload the page to try again.</Alert>
      ) : null}
      {items.length > 0 ? (
        <ul aria-label="Actions" className="flex flex-col gap-2">
          {items.map((i) => (
            <li
              key={i.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-3"
            >
              <span>{i.text}</span>
              <a href={i.href} className="inline-flex min-h-touch items-center text-action underline">
                {i.cta}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
