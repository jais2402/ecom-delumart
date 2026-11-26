"use client";

import { formatInrExact } from "@delulu/core";
import { Alert, Button, Checkbox, EmptyState, Heading, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { type Listing, type ListingDetail, type ListingPage, studioErrorText } from "../../_lib/studio";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

async function loadLive(signal: AbortSignal): Promise<Listing[]> {
  const all: Listing[] = [];
  let cursor: string | null = null;
  do {
    const page: ListingPage = await api<ListingPage>(
      `/api/v1/studio/products?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      { signal },
    );
    all.push(...page.items.filter((l) => l.status === "PUBLISHED" || l.status === "HIDDEN"));
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** /studio/shipping: free Standard delivery (and Express) per listing. Fees are never your revenue. */
export function StudioShipping() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: Listing[] }
  >({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the load
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    loadLive(controller.signal)
      .then((items) => setState({ status: "ready", items }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: describeError(error) });
      });
    return () => controller.abort();
  }, [tick]);
  const retry = useCallback(() => setTick((n) => n + 1), []);

  return (
    <div className="flex flex-col gap-4">
      <PortalTitle>Shipping</PortalTitle>
      <Text size="sm" muted>
        Offer free Standard delivery on a listing and shoppers pay no Standard fee for it. The fee still goes
        to the sink: it is taken out of your proceeds on each order. If an order mixes your listings, the
        shopper pays the fee unless every listing in it offers free Standard delivery.
      </Text>
      {state.status === "loading" ? <LoadingBlock rows={3} label="Loading your shipping options" /> : null}
      {state.status === "error" ? <ErrorBlock message={state.message} onRetry={retry} /> : null}
      {state.status === "ready" && state.items.length === 0 ? (
        <EmptyState title="No live listings" description="Delivery options apply to published listings." />
      ) : null}
      {state.status === "ready" ? (
        <ul className="flex list-none flex-col gap-4 p-0">
          {state.items.map((l) => (
            <li key={l.id}>
              <ShippingCard initial={l} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ShippingCard({ initial }: { initial: Listing }) {
  const [listing, setListing] = useState(initial);
  const [freeStd, setFreeStd] = useState(initial.freeStandardDelivery);
  const [express, setExpress] = useState(initial.offersExpress);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const name = listing.live?.name ?? "Listing";
  const headingId = `sc-${listing.id}`;
  const freeMin =
    listing.sale.rules.freeDeliveryMinPaise === null ? null : BigInt(listing.sale.rules.freeDeliveryMinPaise);
  const livePaise = BigInt(listing.live?.pricePaise ?? "0");
  const dirty = freeStd !== listing.freeStandardDelivery || express !== listing.offersExpress;

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<{ product: ListingDetail }>(`/api/v1/studio/products/${listing.id}/shipping`, {
        method: "POST",
        body: { offersExpress: express, freeStandardDelivery: freeStd },
      });
      setListing(r.product);
      setNotice({ tone: "success", text: "Delivery options saved." });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
      setNotice({
        tone: "danger",
        text:
          code === "FREE_DELIVERY_UNFUNDED" && error instanceof Error
            ? error.message
            : studioErrorText(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id={headingId}>
        {name}
      </Heading>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <div className="flex flex-col gap-1">
        <Checkbox
          checked={freeStd}
          onChange={(e) => setFreeStd(e.target.checked)}
          label={`Free Standard delivery for shoppers (${name})`}
        />
        {freeStd ? (
          <Text size="sm">You pay for it: the delivery fee comes out of your proceeds on every order.</Text>
        ) : null}
        {freeMin !== null ? (
          <Text size="sm" muted>
            Free Standard delivery needs a price of at least {formatInrExact(freeMin)}, so the fee can come
            out of your proceeds. This listing sells at {formatInrExact(livePaise)}.
          </Text>
        ) : null}
        <Checkbox
          checked={express}
          onChange={(e) => setExpress(e.target.checked)}
          label={`Offer Express delivery (${name})`}
        />
      </div>
      <Button
        variant="secondary"
        className="self-start"
        loading={busy}
        disabled={!dirty}
        onClick={() => void save()}
      >
        Save delivery options
      </Button>
    </section>
  );
}
