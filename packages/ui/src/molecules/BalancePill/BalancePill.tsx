import type { ComponentPropsWithRef } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type BalancePillProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  balancePaise: bigint;
  display?: "compact" | "exact";
};

export function BalancePill({ balancePaise, display = "compact", className, ...props }: BalancePillProps) {
  return (
    <div
      className={cn(
        "inline-flex min-h-touch items-center gap-2 rounded-pill border border-border bg-surface px-4 font-body text-sm",
        className,
      )}
      {...props}
    >
      <span className="text-fg-muted">Balance</span>
      <Price amountPaise={balancePaise} display={display} />
      <FictionLabel>fictional money</FictionLabel>
    </div>
  );
}
