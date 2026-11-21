"use client";

import { Button, EmptyState, ProductGrid } from "@delulu/ui";
import { useEffect, useState } from "react";
import { api, type CollectionItem, describeError, type ProductResponse } from "../../_lib/api";
import { toGridItem } from "../../_lib/catalog";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; products: ProductResponse[]; missing: CollectionItem[] };

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
      const [owned, catalog] = await Promise.all([
        api<{ items: CollectionItem[] }>("/api/v1/collection"),
        catalogById(),
      ]);
      const products: ProductResponse[] = [];
      const missing: CollectionItem[] = [];
      for (const item of owned.items) {
        const product = catalog.get(item.productId);
        if (product) products.push(product);
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
            <Button asChild>
              <a href="/">Start shopping</a>
            </Button>
          }
        />
      ) : null}
      {state.status === "ready" && state.products.length > 0 ? (
        <ProductGrid items={state.products.map(toGridItem)} label="Things you own" headingLevel={2} />
      ) : null}
      {state.status === "ready" && state.missing.length > 0 ? (
        <ul aria-label="Other things you own" className="flex flex-col gap-2">
          {state.missing.map((item) => (
            <li key={item.id} className="rounded-lg border border-border bg-surface p-3">
              {item.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
