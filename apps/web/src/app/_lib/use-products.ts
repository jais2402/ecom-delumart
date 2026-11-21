"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type ProductResponse } from "./api";

const known = new Map<string, ProductResponse | null>();

/**
 * Public product details for a list of ids (the signed-out cart holds ids only). Read from the
 * public, cacheable product route; an id that cannot be read maps to null.
 */
export function useProducts(ids: readonly string[]): {
  products: ReadonlyMap<string, ProductResponse | null>;
  loading: boolean;
} {
  const [version, tick] = useState(0);
  const missing = ids.filter((id) => !known.has(id));
  const missingKey = missing.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: missingKey stands for the missing ids
  useEffect(() => {
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (id) => {
        try {
          known.set(id, await api<ProductResponse>(`/api/v1/products/${id}`));
        } catch {
          known.set(id, null);
        }
      }),
    ).then(() => {
      if (!cancelled) tick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [missingKey]);

  // a fresh Map each time more products arrive, so memoised views over it update
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks changes to the module cache
  const snapshot = useMemo(() => new Map(known), [version]);
  return { products: snapshot, loading: missing.length > 0 };
}
