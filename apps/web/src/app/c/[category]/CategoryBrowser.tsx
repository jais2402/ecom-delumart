"use client";

import { rupees } from "@delulu/core";
import { FilterPanel, ProductGrid, type ProductGridItem } from "@delulu/ui";
import { useMemo, useState } from "react";
import { PRICE_STEPS } from "../../_lib/price-steps";

export function CategoryBrowser({ items }: { items: readonly ProductGridItem[] }) {
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [zapOnly, setZapOnly] = useState(false);

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (minPrice && item.pricePaise < rupees(BigInt(minPrice))) return false;
        if (maxPrice && item.pricePaise > rupees(BigInt(maxPrice))) return false;
        if (zapOnly && !item.zapEligible) return false;
        return true;
      }),
    [items, minPrice, maxPrice, zapOnly],
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
      <div className="min-w-0">
        <p role="status" className="mb-3 text-sm text-fg-muted">
          Showing {visible.length} of {items.length} products
        </p>
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
