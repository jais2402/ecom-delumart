"use client";

import { type ComponentPropsWithRef, useId } from "react";
import type { HeadingLevel } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { type FilterOption, FilterTabs } from "../../molecules/FilterTabs";
import { ProductCardSkeleton } from "../../molecules/ProductCardSkeleton";
import { ScrollRow } from "../../molecules/ScrollRow";
import { SectionHeading } from "../../molecules/SectionHeading";
import { ProductCard } from "../ProductCard";
import type { ProductGridItem } from "../ProductGrid";

export type ProductRailProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  /** One muted subtitle line under the bold title. */
  lead?: string;
  items: readonly ProductGridItem[];
  /** Link to the full list, drawn as an underlined "View all" at the right of the heading. */
  seeAll?: { href: string; label: string };
  /**
   * Filter tabs under the heading (toggle buttons). The rail only draws them: the parent owns the
   * chosen key and passes the matching `items`. The row of cards goes back to its start on a change.
   */
  filters?: {
    label: string;
    options: readonly FilterOption[];
    value: string;
    onChange: (key: string) => void;
  };
  headingLevel?: HeadingLevel;
  /** Level of each card's name; one below the rail's heading. */
  cardHeadingLevel?: HeadingLevel;
  /** Show placeholder cards while the products load. */
  loading?: boolean;
  /** Shown when there is nothing to scroll. */
  emptyText?: string;
};

/** Two and a bit cards on a phone, four from 768px, six from 1024px. */
const cell =
  "relative w-[calc((100%-1rem)/2.3)] shrink-0 snap-start md:w-[calc((100%-3rem)/4)] lg:w-[calc((100%-5rem)/6)]";

/**
 * A heading with a muted subtitle and a "View all" link, over a row of product cards that snaps as
 * it scrolls, with previous and next buttons at its edges. The row scrolls with touch, trackpad and
 * the keyboard (Tab through the cards); the buttons are for pointer users and stay focusable at
 * either end so focus is never lost. Sections sit directly on the page, with no panel of their own
 * beyond the white section surface.
 */
export function ProductRail({
  title,
  lead,
  items,
  seeAll,
  filters,
  headingLevel = 2,
  cardHeadingLevel = 3,
  loading = false,
  emptyText = "Nothing here yet.",
  className,
  ...props
}: ProductRailProps) {
  const uid = useId();
  const headingId = `${uid}-title`;
  const hasCards = loading || items.length > 0;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-4 rounded-lg bg-surface p-4 md:p-5", className)}
      {...props}
    >
      <SectionHeading
        title={title}
        {...(lead ? { lead } : {})}
        headingId={headingId}
        headingLevel={headingLevel}
        {...(seeAll ? { seeAll } : {})}
      />
      {filters ? (
        <FilterTabs
          label={filters.label}
          options={filters.options}
          value={filters.value}
          onChange={filters.onChange}
        />
      ) : null}
      {hasCards ? (
        <ScrollRow label={title} loading={loading} resetKey={filters?.value} listClassName="gap-4">
          {loading
            ? Array.from({ length: 6 }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity
                <li key={index} className={cell}>
                  <ProductCardSkeleton />
                </li>
              ))
            : items.map(({ id, ...card }) => (
                <li key={id} className={cell}>
                  <ProductCard headingLevel={cardHeadingLevel} {...card} />
                </li>
              ))}
        </ScrollRow>
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong bg-surface p-4 font-body text-sm text-fg-muted">
          {emptyText}
        </p>
      )}
      {loading ? (
        <p role="status" className="sr-only">
          Loading {title}
        </p>
      ) : filters ? (
        <p role="status" className="sr-only">
          Showing {items.length} {items.length === 1 ? "product" : "products"}
        </p>
      ) : null}
    </section>
  );
}
