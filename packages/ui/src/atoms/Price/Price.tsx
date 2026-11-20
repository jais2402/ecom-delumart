import { formatInrCompact, formatInrExact, inrAccessibleLabel } from "@delulu/core";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { VisuallyHidden } from "../VisuallyHidden";

export type PriceProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** Amount in integer paise. */
  amountPaise: bigint;
  display?: "compact" | "exact";
};

/** Visible text is aria-hidden; the exact, spoken label is visually hidden. */
export function Price({ amountPaise, display = "compact", className, ...props }: PriceProps) {
  const text = display === "exact" ? formatInrExact(amountPaise) : formatInrCompact(amountPaise);
  return (
    <span className={cn("font-body font-semibold tabular-nums text-fg", className)} {...props}>
      <span aria-hidden="true">{text}</span>
      <VisuallyHidden>{inrAccessibleLabel(amountPaise)}</VisuallyHidden>
    </span>
  );
}
