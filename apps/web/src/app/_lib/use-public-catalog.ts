"use client";

import { useEffect, useState } from "react";
import { api, type ProductResponse } from "./api";

/**
 * The products of a statically generated page. Normally the server already put them in the HTML
 * (`initial`); if the page was generated without them (at build time there is no database), the
 * browser reads the public, cacheable /api/v1/catalog route instead.
 */
export function usePublicCatalog(initial: readonly ProductResponse[]): {
  products: readonly ProductResponse[];
  loading: boolean;
} {
  const [fetched, setFetched] = useState<readonly ProductResponse[] | null>(null);
  const needed = initial.length === 0;

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    (async () => {
      const all: ProductResponse[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: ProductResponse[]; nextCursor: string | null } = await api(
          `/api/v1/catalog?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      if (!cancelled) setFetched(all);
    })().catch(() => {
      if (!cancelled) setFetched([]);
    });
    return () => {
      cancelled = true;
    };
  }, [needed]);

  if (!needed) return { products: initial, loading: false };
  return { products: fetched ?? [], loading: fetched === null };
}
