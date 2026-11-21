import type { ComponentPropsWithRef } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type ReceiptLine = { id: string; name: string; quantity: number; totalPaise: bigint };

export type ReceiptProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  reference: string;
  placedAt?: string;
  lines: readonly ReceiptLine[];
  itemsTotalPaise: bigint;
  discountPaise?: bigint;
  deliveryFeePaise: bigint;
  totalPaise: bigint;
  /** Payment status in words, e.g. "Paid". Shown in the receipt header when given. */
  paymentStatus?: string;
};

export function Receipt({
  reference,
  placedAt,
  lines,
  itemsTotalPaise,
  discountPaise,
  deliveryFeePaise,
  totalPaise,
  paymentStatus,
  className,
  ...props
}: ReceiptProps) {
  return (
    <section
      aria-label={`Receipt for order ${reference}`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-4 font-body",
        className,
      )}
      {...props}
    >
      <header>
        <Heading level={2} size="sm">
          Receipt
        </Heading>
        <p className="font-mono text-sm text-fg">Order {reference}</p>
        {placedAt ? <p className="text-sm text-fg-muted">{placedAt}</p> : null}
        {paymentStatus ? (
          <p className="text-sm text-fg">
            <span className="text-fg-muted">Payment: </span>
            <strong>{paymentStatus}</strong>
          </p>
        ) : null}
      </header>
      <ul className="divide-y divide-border border-y border-border">
        {lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 py-2 text-base">
            <span className="min-w-0 text-fg">
              {line.name} <span className="text-fg-muted">× {line.quantity}</span>
            </span>
            <Price amountPaise={line.totalPaise} display="exact" />
          </li>
        ))}
      </ul>
      <dl className="flex flex-col gap-1 text-base">
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">Items</dt>
          <dd>
            <Price amountPaise={itemsTotalPaise} display="exact" />
          </dd>
        </div>
        {discountPaise && discountPaise > 0n ? (
          <div className="flex justify-between gap-3">
            <dt className="text-fg-muted">Discount</dt>
            <dd>
              <span aria-hidden="true">−</span>
              <Price amountPaise={discountPaise} display="exact" />
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-fg-muted">Delivery</dt>
          <dd>{deliveryFeePaise > 0n ? <Price amountPaise={deliveryFeePaise} display="exact" /> : "Free"}</dd>
        </div>
        <div className="flex justify-between gap-3 border-t border-border pt-2 font-bold">
          <dt>Total paid</dt>
          <dd>
            <Price amountPaise={totalPaise} display="exact" />
          </dd>
        </div>
      </dl>
      <FictionLabel>Fictional money · DeluluMart only</FictionLabel>
    </section>
  );
}
