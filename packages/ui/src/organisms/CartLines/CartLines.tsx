import { Trash2 } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { IconButton } from "../../atoms/IconButton";
import { Price } from "../../atoms/Price";
import { ProductArt } from "../../atoms/ProductArt";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../molecules/EmptyState";

export type CartLine = {
  id: string;
  name: string;
  hue: number;
  quantity: number;
  unitPricePaise: bigint;
  href?: string;
};
export type CartSellerGroup = { sellerId: string; sellerName: string; lines: readonly CartLine[] };

export type CartLinesProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  groups: readonly CartSellerGroup[];
  onRemove: (lineId: string) => void;
};

export function CartLines({ groups, onRemove, className, ...props }: CartLinesProps) {
  const nonEmpty = groups.filter((group) => group.lines.length > 0);
  if (nonEmpty.length === 0) {
    return (
      <div className={className} {...props}>
        <EmptyState title="Your cart is empty" description="Add something impossible to get started." />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-6 font-body", className)} {...props}>
      {nonEmpty.map((group) => (
        <section key={group.sellerId} aria-labelledby={`seller-${group.sellerId}`}>
          <Heading level={2} size="sm" id={`seller-${group.sellerId}`} className="mb-2">
            Sold by {group.sellerName}
          </Heading>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {group.lines.map((line) => (
              <li key={line.id} className="flex items-center gap-3 p-3">
                <ProductArt hue={line.hue} seed={line.name} alt="" className="size-16 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-fg">
                    {line.href ? (
                      <a href={line.href} className="underline underline-offset-2">
                        {line.name}
                      </a>
                    ) : (
                      line.name
                    )}
                  </p>
                  <p className="text-sm text-fg-muted">
                    Quantity {line.quantity} ×{" "}
                    <Price amountPaise={line.unitPricePaise} display="exact" className="text-sm font-normal" />
                  </p>
                  <Price amountPaise={line.unitPricePaise * BigInt(line.quantity)} display="exact" />
                </div>
                <IconButton aria-label={`Remove ${line.name} from cart`} onClick={() => onRemove(line.id)}>
                  <Icon icon={Trash2} />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
