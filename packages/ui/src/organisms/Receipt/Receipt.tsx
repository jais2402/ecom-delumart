import type { ComponentPropsWithRef } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type ReceiptLine = {
  id: string;
  name: string;
  quantity: number;
  totalPaise: bigint;
  /** Base hue of the generated art; a small picture is drawn beside the line when this is given. */
  hue?: number;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
};

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
      className={cn("flex flex-col gap-3 rounded-lg bg-surface p-4 font-body md:p-6", className)}
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
          <li key={line.id} className="flex items-center gap-3 py-3 text-base">
            {line.hue === undefined ? null : (
              <ProductPicture
                imageSrc={line.imageSrc}
                hue={line.hue}
                seed={line.name}
                alt=""
                className="size-14 shrink-0"
              />
            )}
            <span className="min-w-0 flex-1 break-words text-fg">
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
