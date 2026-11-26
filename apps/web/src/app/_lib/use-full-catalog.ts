"use client";

import { useEffect, useState } from "react";
import { api, type ProductResponse } from "./api";

/**
 * The whole public catalogue, read once per page load from the same cacheable, public route the
 * search page uses and kept in memory. It sends no ids and no query, so what a shopper typed or
 * viewed stays in the browser. Reading starts only when `enabled` is true.
 */
let cache: readonly ProductResponse[] | null = null;
let inflight: Promise<readonly ProductResponse[]> | null = null;

export function loadFullCatalog(): Promise<readonly ProductResponse[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= (async () => {
    const all: ProductResponse[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: ProductResponse[]; nextCursor: string | null } = await api(
        `/api/v1/catalog?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
      );
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    cache = all;
    return all;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function useFullCatalog(enabled: boolean): { products: readonly ProductResponse[]; ready: boolean } {
  const [products, setProducts] = useState<readonly ProductResponse[]>(cache ?? []);
  const [ready, setReady] = useState(cache !== null);
  useEffect(() => {
    if (!enabled || cache) return;
    let cancelled = false;
    loadFullCatalog()
      .then((all) => {
        if (cancelled) return;
        setProducts(all);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return { products, ready };
}
