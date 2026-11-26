import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type ReviewGroup = {
  sellerId: string;
  sellerName: string;
  /** e.g. "Express". */
  speedName: string;
  itemNames: readonly string[];
  deliveryFeePaise: bigint;
  /** What this seller's part of the order costs, after discounts, including delivery. */
  totalPaise: bigint;
};

export type OrderGroupReviewProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  groups: readonly ReviewGroup[];
  totalPaise: bigint;
};

/** The review step of a multi-seller order: each seller's items, speed and fee, then the total. */
export function OrderGroupReview({ groups, totalPaise, className, ...props }: OrderGroupReviewProps) {
  return (
    <section
      aria-label="Items in this order"
      className={cn("flex flex-col gap-4 font-body", className)}
      {...props}
    >
      {groups.map((group) => (
        <section
          key={group.sellerId}
          aria-labelledby={`review-${group.sellerId}`}
          className="flex flex-col gap-2 rounded-lg bg-surface p-4"
        >
          <Heading level={3} size="sm" id={`review-${group.sellerId}`} className="break-words">
            Sold by {group.sellerName}
          </Heading>
          <ul className="list-disc pl-5 text-base text-fg">
            {group.itemNames.map((name) => (
              <li key={name} className="break-words">
                {name}
              </li>
            ))}
          </ul>
          <dl className="flex flex-col gap-1 border-t border-border pt-2 text-base">
            <div className="flex justify-between gap-3">
              <dt className="text-fg-muted">Delivery speed</dt>
              <dd className="text-fg">{group.speedName}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-fg-muted">Delivery fee</dt>
              <dd>
                {group.deliveryFeePaise > 0n ? (
                  <Price amountPaise={group.deliveryFeePaise} display="exact" />
                ) : (
                  <span className="font-semibold text-success">Free</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-fg-muted">Seller total</dt>
              <dd>
                <Price amountPaise={group.totalPaise} display="exact" />
              </dd>
            </div>
          </dl>
        </section>
      ))}
      <p className="flex items-baseline justify-between gap-3 rounded-lg bg-surface p-4 text-lg font-bold text-fg">
        <span>Order total</span>
        <Price amountPaise={totalPaise} display="exact" />
      </p>
    </section>
  );
}
