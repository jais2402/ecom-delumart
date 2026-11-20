import type { ComponentPropsWithRef, ReactNode } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type OrderSummaryProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  itemsTotalPaise: bigint;
  discountPaise?: bigint;
  deliveryFeePaise: bigint;
  /** Computed by the pricing function, never here. */
  totalPaise: bigint;
};

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", strong && "border-t border-border pt-2")}>
      <dt className={cn("text-fg", strong ? "font-bold" : "text-fg-muted")}>{label}</dt>
      <dd className={strong ? "text-lg" : undefined}>{children}</dd>
    </div>
  );
}

export function OrderSummary({
  itemsTotalPaise,
  discountPaise,
  deliveryFeePaise,
  totalPaise,
  className,
  ...props
}: OrderSummaryProps) {
  return (
    <section
      aria-label="Order summary"
      className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 font-body", className)}
      {...props}
    >
      <Heading level={2} size="sm">
        Order summary
      </Heading>
      <dl className="flex flex-col gap-2 text-base">
        <Row label="Items">
          <Price amountPaise={itemsTotalPaise} display="exact" />
        </Row>
        {discountPaise && discountPaise > 0n ? (
          <Row label="Discount">
            <span aria-hidden="true">−</span>
            <Price amountPaise={discountPaise} display="exact" />
          </Row>
        ) : null}
        <Row label="Delivery">
          {deliveryFeePaise > 0n ? (
            <Price amountPaise={deliveryFeePaise} display="exact" />
          ) : (
            <span className="font-semibold text-success">Free</span>
          )}
        </Row>
        <Row label="Total" strong>
          <Price amountPaise={totalPaise} display="exact" />
        </Row>
      </dl>
      <FictionLabel>Fictional money</FictionLabel>
    </section>
  );
}
