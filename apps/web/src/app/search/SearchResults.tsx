"use client";

import { Heading, ProductGrid, SearchBar } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { SeedProduct } from "../../data/seed-catalog";
import { toGridItem } from "../_lib/catalog";

export function SearchResults({
  initialQuery,
  products,
}: {
  initialQuery: string;
  products: readonly SeedProduct[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return products
      .filter((product) => `${product.name} ${product.hook}`.toLowerCase().includes(needle))
      .map(toGridItem);
  }, [products, query]);

  function search(next: string) {
    setQuery(next);
    router.replace(next ? `/search?q=${encodeURIComponent(next)}` : "/search");
  }

  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="lg">
        {query ? `Results for “${query}”` : "Search"}
      </Heading>
      <SearchBar
        label="Search products"
        defaultValue={initialQuery}
        onSearch={search}
        className="max-w-reading"
      />
      <p role="status" className="text-sm text-fg-muted">
        {query
          ? `${results.length} ${results.length === 1 ? "product" : "products"} found`
          : "Type a name or a hook."}
      </p>
      {query ? (
        <ProductGrid
          items={results}
          label="Search results"
          emptyTitle="Nothing matches that search"
          emptyDescription="Try a shorter word, like “jar” or “moon”."
        />
      ) : null}
    </div>
  );
}
