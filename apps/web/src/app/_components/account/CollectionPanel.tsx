"use client";

import { Badge, Button, EmptyState, ProductGrid } from "@delulu/ui";
import { useEffect, useState } from "react";
import {
  api,
  type CollectionItem,
  describeError,
  type OrderResponse,
  type ProductResponse,
} from "../../_lib/api";
import { toGridItem } from "../../_lib/catalog";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      products: { product: ProductResponse; serial: number | null }[];
      missing: CollectionItem[];
    };

/** Edition serials of what the person bought, by order line. Optional: a failure just hides the serials. */
async function serialsByLine(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    let cursor: string | null = null;
    do {
      const page: { items: OrderResponse[]; nextCursor: string | null } = await api(
        `/api/v1/orders?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      );
      for (const order of page.items)
        for (const so of order.sellerOrders)
          for (const line of so.lines) if (line.editionSerial !== null) map.set(line.id, line.editionSerial);
      cursor = page.nextCursor;
    } while (cursor);
  } catch {
    // serials are a nicety
  }
  return map;
}

/** Public catalog pages (the art and price of what the person owns). */
async function catalogById(): Promise<Map<string, ProductResponse>> {
  const map = new Map<string, ProductResponse>();
  let cursor: string | null = null;
  do {
    const page: { items: ProductResponse[]; nextCursor: string | null } = await api(
      `/api/v1/catalog?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
    );
    for (const product of page.items) map.set(product.id, product);
    cursor = page.nextCursor;
  } while (cursor);
  return map;
}

export function CollectionPanel() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick retries the load
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const [owned, catalog, serials] = await Promise.all([
        api<{ items: CollectionItem[] }>("/api/v1/collection"),
        catalogById(),
        serialsByLine(),
      ]);
      const products: { product: ProductResponse; serial: number | null }[] = [];
      const missing: CollectionItem[] = [];
      for (const item of owned.items) {
        const product = catalog.get(item.productId);
        if (product)
          products.push({
            product,
            serial: item.orderLineId ? (serials.get(item.orderLineId) ?? null) : null,
          });
        else missing.push(item);
      }
      if (!cancelled) setState({ status: "ready", products, missing });
    })().catch((err: unknown) => {
      if (!cancelled) setState({ status: "error", message: describeError(err) });
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>Your collection</PageHeading>
      {state.status === "loading" ? <LoadingBlock rows={3} label="Loading your collection" /> : null}
      {state.status === "error" ? (
        <ErrorBlock message={state.message} onRetry={() => setTick((n) => n + 1)} />
      ) : null}
      {state.status === "ready" && state.products.length + state.missing.length === 0 ? (
        <EmptyState
          title="Nothing collected yet"
          description="Things you buy will live here."
          action={
            <Button asChild variant="cta">
              <a href="/">Start shopping</a>
            </Button>
          }
        />
      ) : null}
      {state.status === "ready" && state.products.length > 0 ? (
        <ProductGrid
          items={state.products.map(({ product, serial }) => {
            const item = toGridItem(product);
            return serial !== null && product.edition
              ? { ...item, stock: { state: "edition" as const, number: serial, of: product.edition.supply } }
              : item;
          })}
          label="Things you own"
          headingLevel={2}
        />
      ) : null}
      {state.status === "ready" && state.missing.length > 0 ? (
        <ul aria-label="Other things you own" className="flex flex-col gap-2">
          {state.missing.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3"
            >
              <span className="break-words">{item.name}</span>
              <Badge tone="neutral">No longer available</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
