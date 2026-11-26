"use client";

import { Button, EmptyState, ProductGrid, type ProductGridItem } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import type { SavedItem, SavedPage } from "../../_lib/selling";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { SaveToggle } from "../SaveToggle";

const PAGE_SIZE = 24;

function toGridItem(item: SavedItem): ProductGridItem {
  const unavailable = !item.published || !item.available;
  return {
    id: item.productId,
    // a withdrawn product has no page to open
    href: item.published ? `/p/${item.productId}` : "/account/saved",
    name: item.name,
    hook: !item.published ? "No longer available" : unavailable ? "Not available right now" : "",
    hue: item.templateId,
    imageAlt: item.altText,
    pricePaise: parsePaise(item.pricePaise),
    storeName: item.sellerName ?? "DeluluMart Originals",
    stock: unavailable ? { state: "sold-out" } : { state: "in-stock" },
    actions: <SaveToggle productId={item.productId} name={item.name} />,
  };
}

/** /account/saved: everything the person has saved, newest first; unavailable products are shown as such. */
export function SavedPanel() {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (after: string | null) => {
    if (after) setMore(true);
    else setState("loading");
    try {
      const page = await api<SavedPage>(
        `/api/v1/saves?limit=${PAGE_SIZE}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`,
      );
      setItems((current) => (after ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setState("ready");
    } catch (err) {
      setError(describeError(err));
      setState("error");
    } finally {
      setMore(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Saved products</PageHeading>
      {state === "loading" ? <LoadingBlock rows={3} label="Loading your saved products" /> : null}
      {state === "error" ? <ErrorBlock message={error} onRetry={() => void load(null)} /> : null}
      {state === "ready" && items.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          description="Tap the heart on a product to keep it here."
          action={
            <Button asChild variant="cta">
              <a href="/">Start shopping</a>
            </Button>
          }
        />
      ) : null}
      {state === "ready" && items.length > 0 ? (
        <>
          <ProductGrid items={items.map(toGridItem)} label="Saved products" headingLevel={2} />
          {cursor ? (
            <Button
              variant="secondary"
              loading={more}
              onClick={() => void load(cursor)}
              className="self-start"
            >
              Show more
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
