import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type VisuallyHiddenProps = ComponentPropsWithRef<"span">;

/** Content available to assistive technology only. */
export function VisuallyHidden({ className, ...props }: VisuallyHiddenProps) {
  return <span className={cn("sr-only", className)} {...props} />;
}
