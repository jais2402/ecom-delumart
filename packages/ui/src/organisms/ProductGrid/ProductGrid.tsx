import type { ComponentPropsWithRef } from "react";
import type { HeadingLevel } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";
import { ProductCardSkeleton } from "../../molecules/ProductCardSkeleton";
import { ProductCard, type ProductCardProps } from "../ProductCard";

export type ProductGridItem = ProductCardProps & { id: string };

export type ProductGridProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  items: readonly ProductGridItem[];
  /** Accessible name of the list. */
  label?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Semantic level of each card name. */
  headingLevel?: HeadingLevel;
  /** Show placeholder cards instead of the items while they load. */
  loading?: boolean;
  /** How many placeholder cards to show while loading. */
  loadingCount?: number;
};

export function ProductGrid({
  items,
  label = "Products",
  emptyTitle = "Nothing here yet",
  emptyDescription = "Try another search or loosen the filters.",
  headingLevel = 3,
  loading = false,
  loadingCount = 8,
  className,
  ...props
}: ProductGridProps) {
  const columns = "grid grid-cols-1 gap-x-6 gap-y-10 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4";
  if (loading) {
    return (
      <div className={className} {...props}>
        <ul aria-label={label} aria-busy="true" className={columns}>
          {Array.from({ length: loadingCount }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
        <p role="status" className="sr-only">
          Loading products
        </p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className={className} {...props}>
        <EmptyState title={emptyTitle} description={emptyDescription} headingLevel={2} />
      </div>
    );
  }
  return (
    <div className={className} {...props}>
      <ul aria-label={label} className={cn(columns)}>
        {items.map(({ id, ...card }) => (
          <li key={id}>
            <ProductCard headingLevel={headingLevel} {...card} />
          </li>
        ))}
      </ul>
    </div>
  );
}
