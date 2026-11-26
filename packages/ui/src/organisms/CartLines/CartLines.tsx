import { ShoppingCart, Trash2 } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";

export type CartLine = {
  id: string;
  name: string;
  hue: number;
  quantity: number;
  unitPricePaise: bigint;
  href?: string;
  /** Description of the imagined product photo; the art is decorative when omitted. */
  imageAlt?: string;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
  /**
   * Plain-language reason this line cannot be bought. The line is marked, its price is struck
   * through and it is left out of the totals by the caller.
   */
  issue?: string;
};
export type CartSellerGroup = {
  sellerId: string;
  sellerName: string;
  lines: readonly CartLine[];
  /** Shown under the group's lines, e.g. the delivery choice for this seller. */
  footer?: ReactNode;
};

export type CartLinesProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  groups: readonly CartSellerGroup[];
  onRemove: (lineId: string) => void;
  /** Where the empty state sends people. */
  emptyAction?: ReactNode;
};

export function CartLines({ groups, onRemove, emptyAction, className, ...props }: CartLinesProps) {
  const nonEmpty = groups.filter((group) => group.lines.length > 0);
  if (nonEmpty.length === 0) {
    return (
      <div className={className} {...props}>
        <EmptyState
          icon={<Icon icon={ShoppingCart} size={32} />}
          title="Your cart is empty"
          description="Add something impossible to get started."
          {...(emptyAction ? { action: emptyAction } : {})}
        />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-4 font-body", className)} {...props}>
      {nonEmpty.map((group) => (
        <section
          key={group.sellerId}
          aria-labelledby={`seller-${group.sellerId}`}
          className="overflow-hidden rounded-lg bg-surface"
        >
          <Heading
            level={2}
            size="sm"
            id={`seller-${group.sellerId}`}
            className="break-words border-b border-border px-4 py-3"
          >
            Sold by {group.sellerName}
          </Heading>
          <ul className="divide-y divide-border">
            {group.lines.map((line) => {
              const issueId = `issue-${line.id}`;
              return (
                <li
                  key={line.id}
                  data-issue={line.issue ? "true" : undefined}
                  className={cn(
                    "flex items-start gap-3 p-4 sm:gap-4",
                    line.issue && "border-l-4 border-l-danger bg-danger-soft",
                  )}
                >
                  <ProductPicture
                    imageSrc={line.imageSrc}
                    hue={line.hue}
                    seed={line.name}
                    alt={line.imageAlt ?? ""}
                    className={cn("size-20 shrink-0 sm:size-28", line.issue && "opacity-60")}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="break-words font-normal text-fg">
                      {line.href ? (
                        <a
                          href={line.href}
                          className="inline-flex min-h-touch items-center hover:text-action hover:underline"
                        >
                          {line.name}
                        </a>
                      ) : (
                        line.name
                      )}
                    </p>
                    <Price
                      amountPaise={line.unitPricePaise * BigInt(line.quantity)}
                      display="exact"
                      className={cn("text-lg font-bold", line.issue && "line-through")}
                    />
                    {line.quantity > 1 ? (
                      <p className="text-sm text-fg-muted">
                        Quantity {line.quantity} ×{" "}
                        <Price
                          amountPaise={line.unitPricePaise}
                          display="exact"
                          className="text-sm font-normal"
                        />
                      </p>
                    ) : null}
                    {line.issue ? (
                      <p id={issueId} className="text-sm font-medium text-danger">
                        {line.issue}
                      </p>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-1 self-start"
                      aria-label={`Remove ${line.name} from cart`}
                      {...(line.issue ? { "aria-describedby": issueId } : {})}
                      onClick={() => onRemove(line.id)}
                    >
                      <Icon icon={Trash2} size={16} />
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {group.footer ? <div className="border-t border-border bg-surface p-4">{group.footer}</div> : null}
        </section>
      ))}
    </div>
  );
}
