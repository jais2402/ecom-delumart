import { Trash2 } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Heading } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { IconButton } from "../../atoms/IconButton";
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
          title="Your cart is empty"
          description="Add something impossible to get started."
          {...(emptyAction ? { action: emptyAction } : {})}
        />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-6 font-body", className)} {...props}>
      {nonEmpty.map((group) => (
        <section key={group.sellerId} aria-labelledby={`seller-${group.sellerId}`}>
          <Heading level={2} size="sm" id={`seller-${group.sellerId}`} className="mb-2 break-words">
            Sold by {group.sellerName}
          </Heading>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {group.lines.map((line) => {
              const issueId = `issue-${line.id}`;
              return (
                <li
                  key={line.id}
                  data-issue={line.issue ? "true" : undefined}
                  className={cn(
                    "flex items-start gap-3 p-3 first:rounded-t-lg last:rounded-b-lg",
                    line.issue && "border-l-4 border-l-danger bg-danger-soft",
                  )}
                >
                  <ProductPicture
                    imageSrc={line.imageSrc}
                    hue={line.hue}
                    seed={line.name}
                    alt={line.imageAlt ?? ""}
                    className={cn("size-16 shrink-0", line.issue && "opacity-60")}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-fg">
                      {line.href ? (
                        <a
                          href={line.href}
                          className="inline-flex min-h-touch items-center underline underline-offset-2"
                        >
                          {line.name}
                        </a>
                      ) : (
                        line.name
                      )}
                    </p>
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
                    <Price
                      amountPaise={line.unitPricePaise * BigInt(line.quantity)}
                      display="exact"
                      className={cn(line.issue && "line-through")}
                    />
                    {line.issue ? (
                      <p id={issueId} className="mt-1 text-sm font-medium text-danger">
                        {line.issue}
                      </p>
                    ) : null}
                  </div>
                  <IconButton
                    aria-label={`Remove ${line.name} from cart`}
                    {...(line.issue ? { "aria-describedby": issueId } : {})}
                    onClick={() => onRemove(line.id)}
                  >
                    <Icon icon={Trash2} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          {group.footer ? <div className="mt-3">{group.footer}</div> : null}
        </section>
      ))}
    </div>
  );
}
