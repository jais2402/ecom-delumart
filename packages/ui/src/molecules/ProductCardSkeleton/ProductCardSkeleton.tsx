import type { ComponentPropsWithRef } from "react";
import { Skeleton } from "../../atoms/Skeleton";
import { cn } from "../../lib/cn";

export type ProductCardSkeletonProps = Omit<ComponentPropsWithRef<"div">, "children">;

/** The shape of a product card while its data loads: grey rounded blocks. Decorative; the list around it says it is busy. */
export function ProductCardSkeleton({ className, ...props }: ProductCardSkeletonProps) {
  return (
    <div aria-hidden="true" className={cn("flex h-full flex-col gap-2", className)} {...props}>
      <Skeleton className="aspect-square h-auto w-full rounded-lg" />
      <Skeleton className="h-11 w-24 rounded-pill" />
      <Skeleton className="h-6 w-1/3 rounded-lg" />
      <Skeleton className="h-5 w-full rounded-lg" />
      <Skeleton className="h-5 w-3/5 rounded-lg" />
      <Skeleton className="h-4 w-2/5 rounded-lg" />
    </div>
  );
}
