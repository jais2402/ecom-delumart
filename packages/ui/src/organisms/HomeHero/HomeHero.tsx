"use client";

import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { PromoCard, type PromoCardItem } from "../../molecules/PromoCard";
import { ScrollRow } from "../../molecules/ScrollRow";

export type HomeHeroProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  /** The cards, in order. The first one's headline is the page's one h1. */
  cards: readonly PromoCardItem[];
  /** Accessible name of the row. */
  label?: string;
};

/**
 * A row of tall promo cards, three visible from 1024px with the fourth peeking, scrolling sideways
 * with touch, trackpad or the previous and next buttons. Nothing moves on its own, so there is no
 * pause control and nothing to switch off for reduced motion.
 */
export function HomeHero({ cards, label = "Featured", className, ...props }: HomeHeroProps) {
  return (
    <section aria-label={label} className={cn("min-w-0", className)} {...props}>
      <ScrollRow label={label} arrowClassName="top-1/2 -translate-y-1/2" listClassName="gap-4">
        {cards.map((card, index) => (
          <li
            key={card.id}
            className="relative w-[82%] shrink-0 snap-start md:w-[calc((100%-1rem)/2.2)] lg:w-[calc((100%-3rem)/3.2)]"
          >
            <PromoCard item={card} headingLevel={index === 0 ? 1 : 2} eager={index < 3} />
          </li>
        ))}
      </ScrollRow>
    </section>
  );
}
