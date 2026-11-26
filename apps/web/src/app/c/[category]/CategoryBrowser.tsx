"use client";

import { rupees } from "@delulu/core";
import { FilterPanel, ProductGrid, type ProductGridItem, SortMenu } from "@delulu/ui";
import { useMemo, useState } from "react";
import { useBlockedSellerKeys } from "../../_lib/blocks-store";
import { PRICE_STEPS } from "../../_lib/price-steps";
import { isSortKey, SORT_OPTIONS, type SortKey, sortItems } from "../../_lib/sort-items";

/** `sellers` maps a product id to its seller key, so products of shops the viewer blocked can be left out. */
export function CategoryBrowser({
  items: all,
  sellers = {},
}: {
  items: readonly ProductGridItem[];
  sellers?: Readonly<Record<string, string>>;
}) {
  const blocked = useBlockedSellerKeys();
  const items = useMemo(
    () => all.filter((item) => !blocked.has(sellers[item.id] ?? "")),
    [all, blocked, sellers],
  );
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [zapOnly, setZapOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("match");

  const visible = useMemo(
    () =>
      sortItems(
        items.filter((item) => {
          if (minPrice && item.pricePaise < rupees(BigInt(minPrice))) return false;
          if (maxPrice && item.pricePaise > rupees(BigInt(maxPrice))) return false;
          if (zapOnly && !item.zapEligible) return false;
          return true;
        }),
        sort,
      ),
    [items, minPrice, maxPrice, zapOnly, sort],
  );

  return (
    <div className="grid items-start gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      <FilterPanel
        priceSteps={PRICE_STEPS}
        minPrice={minPrice}
        maxPrice={maxPrice}
        onPriceChange={({ min, max }) => {
          setMinPrice(min);
          setMaxPrice(max);
        }}
        zapOnly={zapOnly}
        onZapOnlyChange={setZapOnly}
        onReset={() => {
          setMinPrice("");
          setMaxPrice("");
          setZapOnly(false);
        }}
      />
      <div className="min-w-0 rounded-lg bg-surface p-5 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-fg-muted">
            Showing {visible.length} of {items.length} products
          </p>
          <SortMenu options={SORT_OPTIONS} value={sort} onChange={(key) => isSortKey(key) && setSort(key)} />
        </div>
        <ProductGrid
          items={visible}
          label="Products in this category"
          headingLevel={2}
          emptyTitle="No products match these filters"
          emptyDescription="Widen the price range or switch off Zap."
        />
      </div>
    </div>
  );
}
