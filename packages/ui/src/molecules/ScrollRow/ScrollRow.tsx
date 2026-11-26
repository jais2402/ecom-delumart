"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Children,
  type ComponentPropsWithRef,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type ScrollRowProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Names the buttons: "Previous in <label>" and "Next in <label>". */
  label: string;
  /** The row's items, each an `li` that sets its own width and `shrink-0 snap-start`. */
  children: ReactNode;
  /** Classes for the list itself, such as the gap. */
  listClassName?: string;
  /** Mark the list busy while its items load. */
  loading?: boolean;
  /** Changing this sends the row back to its first item. */
  resetKey?: string;
  /** Vertical position of the buttons, as a Tailwind top class. */
  arrowClassName?: string;
};

const arrow =
  "absolute z-10 inline-flex min-h-touch min-w-touch items-center justify-center rounded-pill border border-border bg-surface text-fg shadow-raised transition-colors duration-fast hover:bg-surface-raised aria-disabled:cursor-not-allowed aria-disabled:opacity-40 max-md:hidden";

/**
 * A horizontally scrolling, snapping list with previous and next buttons at its edges (from 768px;
 * touch and trackpads scroll it directly). The list is a normal scroll container, so Tab walks its
 * items; the buttons stay focusable at either end (marked `aria-disabled`) so focus is never lost.
 */
export function ScrollRow({
  label,
  children,
  listClassName,
  loading = false,
  resetKey,
  arrowClassName = "top-1/3",
  className,
  ...props
}: ScrollRowProps) {
  const scroller = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const count = Children.count(children);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the number of items changes
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, count, loading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key starts the row from its first item
  useEffect(() => {
    scroller.current?.scrollTo?.({ left: 0, behavior: "auto" });
  }, [resetKey]);

  function scrollBy(direction: -1 | 1) {
    const el = scroller.current;
    if (!el?.scrollBy) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  }

  return (
    <div className={cn("relative", className)} {...props}>
      <ul
        ref={scroller}
        onScroll={measure}
        aria-busy={loading || undefined}
        className={cn(
          "-mx-4 flex snap-x snap-mandatory scroll-px-4 overflow-x-auto scroll-smooth px-4 pb-2 md:mx-0 md:scroll-px-0 md:px-0 [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden",
          listClassName,
        )}
      >
        {children}
      </ul>
      <button
        type="button"
        aria-label={`Previous in ${label}`}
        aria-disabled={edges.start || undefined}
        onClick={() => !edges.start && scrollBy(-1)}
        className={cn(arrow, "-left-3", arrowClassName)}
      >
        <Icon icon={ChevronLeft} />
      </button>
      <button
        type="button"
        aria-label={`Next in ${label}`}
        aria-disabled={edges.end || undefined}
        onClick={() => !edges.end && scrollBy(1)}
        className={cn(arrow, "-right-3", arrowClassName)}
      >
        <Icon icon={ChevronRight} />
      </button>
    </div>
  );
}
