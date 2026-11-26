"use client";

import { Heading, ProductGrid, SearchBar, SortMenu } from "@delulu/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toShopGridItem } from "../_components/shop-items";
import { trackClient } from "../_lib/analytics";
import type { ProductResponse } from "../_lib/api";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { isSortKey, SORT_OPTIONS, type SortKey, sortItems } from "../_lib/sort-items";
import { usePublicCatalog } from "../_lib/use-public-catalog";

export function SearchResults({ products: initial }: { products: readonly ProductResponse[] }) {
  const { products: all } = usePublicCatalog(initial);
  const blocked = useBlockedSellerKeys();
  const products = useMemo(() => withoutBlocked(all, blocked), [all, blocked]);
  const router = useRouter();
  const query = useSearchParams().get("q") ?? "";
  const [sort, setSort] = useState<SortKey>("match");

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return products
      .filter((product) => `${product.name} ${product.hook ?? ""}`.toLowerCase().includes(needle))
      .map(toShopGridItem);
  }, [products, query]);
  const shown = useMemo(() => sortItems(results, sort), [results, sort]);

  // one search event per query: its length and result count only, never the query itself
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    const needle = query.trim();
    if (!needle || tracked.current === needle) return;
    tracked.current = needle;
    trackClient("search", { resultCount: results.length, queryLength: needle.length });
  }, [query, results.length]);

  function search(next: string) {
    router.replace(next ? `/search?q=${encodeURIComponent(next)}` : "/search");
  }

  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="lg">
        {query ? `Results for “${query}”` : "Search"}
      </Heading>
      <SearchBar
        label="Search products"
        key={query}
        defaultValue={query}
        onSearch={search}
        className="max-w-reading"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-fg-muted">
          {query
            ? `${results.length} ${results.length === 1 ? "product" : "products"} found`
            : "Type a name or a hook."}
        </p>
        {query && results.length > 1 ? (
          <SortMenu options={SORT_OPTIONS} value={sort} onChange={(key) => isSortKey(key) && setSort(key)} />
        ) : null}
      </div>
      {query ? (
        <ProductGrid
          items={shown}
          label="Search results"
          headingLevel={2}
          emptyTitle="Nothing matches that search"
          emptyDescription="Try a shorter word, like “jar” or “moon”."
        />
      ) : null}
    </div>
  );
}
