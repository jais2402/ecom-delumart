import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type FictionLabelProps = ComponentPropsWithRef<"span">;

/** Reminder that amounts are game money. Place near anything showing an amount. */
export function FictionLabel({ className, children = "Fictional money", ...props }: FictionLabelProps) {
  return (
    <span
      className={cn("font-body text-xs font-medium uppercase tracking-wide text-fg-muted", className)}
      {...props}
    >
      {children}
    </span>
  );
}
