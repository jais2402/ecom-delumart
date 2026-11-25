import type { ComponentPropsWithRef } from "react";
import { Badge } from "../../atoms/Badge";
import { Price } from "../../atoms/Price";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type PriceBlockProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  amountPaise: bigint;
  /** Original price, shown struck through. */
  referenceAmountPaise?: bigint;
  display?: "compact" | "exact";
  /** Text of the sale badge; shown only when a reference price is given and this is set. */
  saleLabel?: string;
  /** Replaces the size and weight classes of the main price, for a hero price. */
  priceClassName?: string;
};

export function PriceBlock({
  amountPaise,
  referenceAmountPaise,
  display = "compact",
  saleLabel,
  priceClassName,
  className,
  ...props
}: PriceBlockProps) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)} {...props}>
      <Price amountPaise={amountPaise} display={display} className={cn("text-xl", priceClassName)} />
      {referenceAmountPaise !== undefined ? (
        <span className="text-sm text-fg-muted">
          <VisuallyHidden>Was </VisuallyHidden>
          <Price
            amountPaise={referenceAmountPaise}
            display={display}
            className="font-normal text-fg-muted line-through"
          />
        </span>
      ) : null}
      {referenceAmountPaise !== undefined && saleLabel ? <Badge tone="highlight">{saleLabel}</Badge> : null}
    </div>
  );
}
