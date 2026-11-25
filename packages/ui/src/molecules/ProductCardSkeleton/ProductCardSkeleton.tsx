import type { ComponentPropsWithRef } from "react";
import { Skeleton } from "../../atoms/Skeleton";
import { cn } from "../../lib/cn";

export type ProductCardSkeletonProps = Omit<ComponentPropsWithRef<"div">, "children">;

/** The shape of a product card while its data loads. Decorative; the list around it says it is busy. */
export function ProductCardSkeleton({ className, ...props }: ProductCardSkeletonProps) {
  return (
    <div aria-hidden="true" className={cn("flex h-full flex-col gap-3", className)} {...props}>
      <Skeleton className="aspect-square h-auto w-full rounded-md" />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="size-10 rounded-md" />
    </div>
  );
}
