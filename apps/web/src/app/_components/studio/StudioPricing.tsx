"use client";

import { formatInrExact } from "@delulu/core";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  FormField,
  Heading,
  Input,
  Price,
  parseRupees,
  priceReading,
  Text,
} from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import {
  type Listing,
  type ListingDetail,
  type ListingPage,
  listingFieldErrors,
  studioErrorText,
} from "../../_lib/studio";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

const REASON_LABEL: Record<string, string> = {
  PUBLISHED: "Published",
  PRICE_CHANGE: "Price changed",
  REVISION: "Revised",
  SALE_START: "Sale started",
  SALE_CHANGE: "Sale price changed",
  SALE_END: "Sale ended",
};

async function loadPublished(signal: AbortSignal): Promise<Listing[]> {
  const all: Listing[] = [];
  let cursor: string | null = null;
  do {
    const page: ListingPage = await api<ListingPage>(
      `/api/v1/studio/products?status=PUBLISHED&limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      { signal },
    );
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** /studio/pricing: set or end a sale on each live listing, and read its price history. */
export function StudioPricing() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: Listing[] }
  >({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the load
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadPublished(controller.signal)
      .then((items) => setState({ status: "ready", items }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: describeError(error) });
      });
    return () => controller.abort();
  }, [tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  const rules = state.status === "ready" ? state.items[0]?.sale.rules : undefined;
  return (
    <div className="flex flex-col gap-4">
      <PortalTitle>Pricing</PortalTitle>
      <Text size="sm" muted>
        Put a live listing on sale at a lower price. Shoppers see a crossed-out "Was" price only when it is
        the lowest price the listing had in the last {rules?.referenceLookbackDays ?? "…"} days, it is higher
        than the sale price, and the listing was published for at least {rules?.referenceMinHours ?? "…"}{" "}
        hours in that time; otherwise they see only the current price. Ending a sale brings back the list
        price.
      </Text>
      {state.status === "loading" ? <LoadingBlock rows={3} label="Loading your prices" /> : null}
      {state.status === "error" ? <ErrorBlock message={state.message} onRetry={retry} /> : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState
          title="No live listings"
          description="Only published listings can go on sale. Publish one first."
        />
      ) : null}
      {state.status === "ready" ? (
        <ul className="flex list-none flex-col gap-4 p-0">
          {state.items.map((l) => (
            <li key={l.id}>
              <PricingCard initial={l} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PricingCard({ initial }: { initial: Listing }) {
  const [listing, setListing] = useState<Listing>(initial);
  const [history, setHistory] = useState<ListingDetail["priceHistory"] | null>(null);
  const [price, setPrice] = useState("");
  const [needRef, setNeedRef] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const name = listing.live?.name ?? "Listing";
  const sale = listing.sale;
  const rules = sale.rules;
  const rupeeOf = (paise: string) => parsePaise(paise) / 100n;
  const freeMin = rules.freeDeliveryMinPaise === null ? null : parsePaise(rules.freeDeliveryMinPaise);
  const livePrice = listing.live ? parsePaise(listing.live.pricePaise) : null;
  const headingId = `pc-${listing.id}`;

  async function loadHistory() {
    try {
      const r = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${listing.id}`);
      setHistory(r.product.priceHistory);
    } catch (error) {
      setNotice({ tone: "danger", text: studioErrorText(error) });
    }
  }

  async function run(method: "PUT" | "DELETE", body: unknown, done: string) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${listing.id}/sale-price`, {
        method,
        ...(body === undefined ? {} : { body }),
      });
      setListing(r.product);
      setHistory(r.product.priceHistory);
      setPrice("");
      setNotice({ tone: "success", text: done });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
      const fields = listingFieldErrors(error);
      setNotice({
        tone: "danger",
        text:
          code === "REFERENCE_PRICE_INELIGIBLE"
            ? `A "Was" price cannot show for this sale price: the lowest price of the last ${rules.referenceLookbackDays} days must be higher than it, and the listing must have been published for ${rules.referenceMinHours} hours. Nothing was changed. Start the sale without that option to show only the current price.`
            : code === "FREE_DELIVERY_UNFUNDED" && error instanceof Error
              ? error.message
              : code === "RATE_LIMITED"
                ? `This listing's price changed ${rules.priceChangesPerDay} times in ${rules.priceChangeWindowHours} hours. Try again later. You can still end a sale.`
                : (Object.values(fields)[0]?.[0] ?? studioErrorText(error)),
      });
    } finally {
      setBusy(false);
    }
  }

  function start() {
    const rupees = parseRupees(price);
    const min = rupeeOf(rules.priceMinPaise);
    const max = rupeeOf(rules.priceMaxPaise);
    if (rupees === null || rupees < min || rupees > max) {
      setPriceError(`Enter whole rupees from ${min} to ${max}.`);
      return;
    }
    if (listing.freeStandardDelivery && freeMin !== null && rupees * 100n < freeMin) {
      setPriceError(
        `Free Standard delivery is on, so the price must be at least ${formatInrExact(freeMin)}: the delivery fee comes out of your proceeds.`,
      );
      return;
    }
    const list = sale.active ? sale.listPaise : listing.live?.pricePaise;
    if (list !== null && list !== undefined && rupees * 100n >= parsePaise(list)) {
      setPriceError("A sale price is lower than the list price.");
      return;
    }
    setPriceError(null);
    void run(
      "PUT",
      { salePriceRupees: Number(rupees), ...(needRef ? { requireReference: true } : {}) },
      sale.active ? "Sale price changed. Shoppers see it now." : "Sale started. Shoppers see it now.",
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={2} size="sm" id={headingId}>
          {name}
        </Heading>
        {sale.active ? <Badge tone="highlight">On sale</Badge> : null}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="text-fg-muted">Shoppers pay</dt>
        <dd>{livePrice !== null ? <Price amountPaise={livePrice} display="exact" /> : "—"}</dd>
        {sale.active && sale.listPaise ? (
          <>
            <dt className="text-fg-muted">List price (after the sale)</dt>
            <dd>
              <Price amountPaise={parsePaise(sale.listPaise)} display="exact" />
            </dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Shown crossed out as "Was"</dt>
        <dd data-testid="was-price">
          {sale.referencePaise ? (
            <Price amountPaise={parsePaise(sale.referencePaise)} display="exact" />
          ) : (
            "Nothing"
          )}
        </dd>
      </dl>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <FormField
        label={`Sale price in rupees for ${name}`}
        hint={
          priceReading(price) ??
          (sale.canShowReference && sale.referenceCeilingPaise
            ? `A "Was" price of ${formatInrExact(parsePaise(sale.referenceCeilingPaise))} will show if you set a lower sale price now (the lowest price of the last ${rules.referenceLookbackDays} days).`
            : `A "Was" price would not show now: the listing has not been published for ${rules.referenceMinHours} hours yet (hidden time does not count).`) +
            (listing.freeStandardDelivery && freeMin !== null
              ? ` Free Standard delivery is on: the price must be at least ${formatInrExact(freeMin)}.`
              : "") +
            ` ${rules.changesRemaining} of ${rules.priceChangesPerDay} price changes left in ${rules.priceChangeWindowHours} hours.`
        }
        error={priceError}
      >
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        )}
      </FormField>
      <Checkbox
        checked={needRef}
        onChange={(e) => setNeedRef(e.target.checked)}
        label={`Only do this if the earlier price can show as "Was" (${name})`}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy} onClick={start}>
          {sale.active ? "Change sale price" : "Start sale"}
        </Button>
        {sale.active ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run("DELETE", undefined, "Sale ended. The list price is back.")}
          >
            End sale
          </Button>
        ) : null}
        {history === null ? (
          <Button variant="ghost" disabled={busy} onClick={() => void loadHistory()}>
            Show price history
          </Button>
        ) : null}
      </div>
      {history !== null ? (
        <DataTable
          caption={`Price history of ${name}`}
          emptyTitle="No price changes yet"
          rows={history}
          rowKey={(h) => `${h.versionId}-${h.changedAt}`}
          columns={[
            { key: "when", header: "When", cell: (h) => formatWhen(h.changedAt) },
            { key: "what", header: "What", cell: (h) => REASON_LABEL[h.reason ?? ""] ?? "Changed" },
            {
              key: "from",
              header: "From",
              align: "right",
              cell: (h) =>
                h.previousPaise ? <Price amountPaise={parsePaise(h.previousPaise)} display="exact" /> : "—",
            },
            {
              key: "to",
              header: "To",
              align: "right",
              cell: (h) => <Price amountPaise={parsePaise(h.pricePaise)} display="exact" />,
            },
          ]}
        />
      ) : null}
    </section>
  );
}
