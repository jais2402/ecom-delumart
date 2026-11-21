import { formatInrExact } from "@delulu/core";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type OrderEquationProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  listPaise: bigint;
  discountPaise: bigint;
  feePaise: bigint;
  /** Delivery the seller paid; delivery the buyer paid is not part of the seller's money. */
  deliverySellerPaise: bigint;
};

/** gross = list - discount; net = gross - fee - delivery you paid. Shown as two short equations. */
export function OrderEquation({
  listPaise,
  discountPaise,
  feePaise,
  deliverySellerPaise,
  className,
  ...props
}: OrderEquationProps) {
  const gross = listPaise - discountPaise;
  const net = gross - feePaise - deliverySellerPaise;
  const part = (label: string, value: bigint) => (
    <span className="inline-flex flex-col">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="font-bold tabular-nums">{formatInrExact(value)}</span>
    </span>
  );
  const op = (symbol: string) => (
    <span aria-hidden="true" className="px-2 text-fg-muted">
      {symbol}
    </span>
  );
  return (
    <div className={cn("flex flex-col gap-3 font-body text-fg", className)} {...props}>
      <p data-testid="equation-gross">
        <span className="sr-only">{`List ${formatInrExact(listPaise)} minus your discount ${formatInrExact(discountPaise)} equals gross ${formatInrExact(gross)}`}</span>
        <span aria-hidden="true" className="flex flex-wrap items-end">
          {part("List price", listPaise)}
          {op("−")}
          {part("Your discount", discountPaise)}
          {op("=")}
          {part("Gross", gross)}
        </span>
      </p>
      <p data-testid="equation-net">
        <span className="sr-only">{`Gross ${formatInrExact(gross)} minus fee ${formatInrExact(feePaise)} minus delivery you paid ${formatInrExact(deliverySellerPaise)} equals net ${formatInrExact(net)}`}</span>
        <span aria-hidden="true" className="flex flex-wrap items-end">
          {part("Gross", gross)}
          {op("−")}
          {part("Marketplace fee", feePaise)}
          {op("−")}
          {part("Delivery you paid", deliverySellerPaise)}
          {op("=")}
          {part("Net", net)}
        </span>
      </p>
    </div>
  );
}
