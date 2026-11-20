import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";
import { ProductCard, type ProductCardProps } from "../ProductCard";

export type ProductGridItem = ProductCardProps & { id: string };

export type ProductGridProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  items: readonly ProductGridItem[];
  /** Accessible name of the list. */
  label?: string;
  emptyTitle?: string;
  emptyDescription?: string;
};

export function ProductGrid({
  items,
  label = "Products",
  emptyTitle = "Nothing here yet",
  emptyDescription = "Try another search or loosen the filters.",
  className,
  ...props
}: ProductGridProps) {
  if (items.length === 0) {
    return (
      <div className={className} {...props}>
        <EmptyState title={emptyTitle} description={emptyDescription} headingLevel={2} />
      </div>
    );
  }
  return (
    <div className={className} {...props}>
      <ul
        aria-label={label}
        className={cn("grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4")}
      >
        {items.map(({ id, ...card }) => (
          <li key={id}>
            <ProductCard {...card} />
          </li>
        ))}
      </ul>
    </div>
  );
}
