"use client";

import { CopyCode, EmptyState, FictionLabel, Heading, ProductGrid, Skeleton, Text } from "@delulu/ui";
import { useMemo } from "react";
import { useBlockedSellerKeys, withoutBlocked } from "../../_lib/blocks-store";
import { describeCoupon } from "../../_lib/merchant";
import { useDeals } from "../../_lib/use-deals";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";
import { toShopGridItem } from "../shop-items";

/**
 * /deals: products on sale (those that carry a real reference price) and the public coupons that
 * shops already show on their own pages. Plain facts only: no countdowns, no "selling fast", no
 * "only N left" (PRD section 7.11).
 */
export function DealsScreen() {
  const { state, reload } = useDeals();
  const blocked = useBlockedSellerKeys();
  const sale = useMemo(
    () => (state.status === "ready" ? withoutBlocked(state.sale, blocked).map(toShopGridItem) : []),
    [state, blocked],
  );

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <header className="rounded-lg bg-surface p-5 md:p-6">
        <PageHeading size="xl">Deals</PageHeading>
        <Text muted className="mt-1 max-w-reading">
          Products priced below their usual price, and coupons that shops share publicly.
        </Text>
      </header>

      {state.status === "loading" ? <LoadingBlock rows={3} label="Loading deals" /> : null}
      {state.status === "error" ? (
        <ErrorBlock
          message="The deals could not be loaded. Check your connection and try again."
          onRetry={reload}
        />
      ) : null}

      {state.status === "ready" ? (
        <>
          <section
            aria-labelledby="deals-sale"
            className="flex flex-col gap-4 rounded-lg bg-surface p-4 md:p-6"
          >
            <Heading level={2} size="md" id="deals-sale">
              On sale
            </Heading>
            {sale.length === 0 ? (
              <EmptyState
                title="Nothing is on sale right now"
                description="When a shop lowers a price, the product appears here with its usual price beside it."
                headingLevel={3}
              />
            ) : (
              <>
                <Text size="sm" muted>
                  The struck-through price is the lowest price the product had in the last 30 days.
                </Text>
                <ProductGrid items={sale} label="Products on sale" headingLevel={3} />
              </>
            )}
          </section>

          <section
            aria-labelledby="deals-coupons"
            className="flex flex-col gap-4 rounded-lg bg-surface p-4 md:p-6"
          >
            <Heading level={2} size="md" id="deals-coupons">
              Shop coupons
            </Heading>
            {!state.couponsReady ? (
              <Skeleton className="h-24 w-full" />
            ) : state.coupons.length === 0 ? (
              <EmptyState
                title="No public coupons right now"
                description="Shops can share coupon codes on their pages. Any that do will be listed here."
                headingLevel={3}
              />
            ) : (
              <>
                <Text size="sm" muted>
                  Enter a code in your cart to use it. <FictionLabel>Fictional money</FictionLabel>
                </Text>
                <ul aria-label="Shop coupons" className="grid gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
                  {state.coupons.map(({ shop, coupon }) => (
                    <li
                      key={`${shop.handle}:${coupon.code}`}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                    >
                      <a
                        href={`/store/${shop.handle}`}
                        className="inline-flex min-h-touch items-center font-bold text-action underline"
                      >
                        {shop.name}
                      </a>
                      <CopyCode code={coupon.code} noun={`coupon code from ${shop.name}`} />
                      <ul className="list-disc pl-5 text-sm text-fg">
                        {describeCoupon(coupon).map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
