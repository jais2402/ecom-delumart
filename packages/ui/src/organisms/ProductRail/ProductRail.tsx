"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ComponentPropsWithRef, useCallback, useEffect, useId, useRef, useState } from "react";
import type { HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { type FilterOption, FilterTabs } from "../../molecules/FilterTabs";
import { ProductCardSkeleton } from "../../molecules/ProductCardSkeleton";
import { SectionHeading } from "../../molecules/SectionHeading";
import { ProductCard } from "../ProductCard";
import type { ProductGridItem } from "../ProductGrid";

export type ProductRailProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  /** A grey sentence after the bold title, on the same line. */
  lead?: string;
  items: readonly ProductGridItem[];
  /** Link to the full list, drawn as an outlined "View all" button. */
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

const arrow =
  "absolute top-1/3 z-10 inline-flex min-h-touch min-w-touch items-center justify-center rounded-pill border border-border bg-surface text-fg shadow-raised transition-colors duration-fast hover:bg-surface-raised aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

const cell = "w-[calc((100%-1rem)/2)] shrink-0 snap-start min-[480px]:w-64 lg:w-[calc((100%-3rem)/4)]";

/**
 * A row of product cards that snaps as it scrolls, four visible from 1024px, with previous and next
 * buttons at its edges. The row scrolls with touch, trackpad and the keyboard (Tab through the cards);
 * the buttons are for pointer users and stay focusable at either end so focus is never lost.
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
  const scroller = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the number of cards changes
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, items.length, loading]);

  const filterValue = filters?.value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts the row from its first card
  useEffect(() => {
    scroller.current?.scrollTo?.({ left: 0, behavior: "auto" });
  }, [filterValue]);

  function scrollBy(direction: -1 | 1) {
    const el = scroller.current;
    if (!el?.scrollBy) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  }

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
        <div className="relative">
          <ul
            ref={scroller}
            onScroll={measure}
            aria-busy={loading || undefined}
            className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto scroll-smooth px-4 pt-1 pb-2 md:-mx-5 md:scroll-px-5 md:px-5 [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden"
          >
            {loading
              ? Array.from({ length: 5 }, (_, index) => (
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
          </ul>
          <button
            type="button"
            aria-label={`Previous in ${title}`}
            aria-disabled={edges.start || undefined}
            onClick={() => !edges.start && scrollBy(-1)}
            className={cn(arrow, "left-0 max-md:hidden")}
          >
            <Icon icon={ChevronLeft} />
          </button>
          <button
            type="button"
            aria-label={`Next in ${title}`}
            aria-disabled={edges.end || undefined}
            onClick={() => !edges.end && scrollBy(1)}
            className={cn(arrow, "right-0 max-md:hidden")}
          >
            <Icon icon={ChevronRight} />
          </button>
        </div>
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
