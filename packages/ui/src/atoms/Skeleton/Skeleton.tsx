import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type SkeletonProps = ComponentPropsWithRef<"div">;

/** Placeholder block shown while content loads. Decorative. */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("h-4 animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
