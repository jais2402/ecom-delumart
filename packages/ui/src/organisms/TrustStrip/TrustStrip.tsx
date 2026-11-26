import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { TrustItem } from "../../molecules/TrustItem";

export type TrustStripItem = { icon: LucideIcon; title: string; text: string };

export type TrustStripProps = Omit<ComponentPropsWithRef<"ul">, "children"> & {
  items: readonly TrustStripItem[];
  /** Accessible name of the list. */
  label?: string;
};

/** A compact promise row: four icon and two-line items in one panel; a 2 by 2 grid on phones. */
export function TrustStrip({ items, label = "Good to know", className, ...props }: TrustStripProps) {
  return (
    <ul
      aria-label={label}
      className={cn("grid grid-cols-2 gap-x-4 gap-y-4 rounded-lg bg-surface p-4 lg:grid-cols-4", className)}
      {...props}
    >
      {items.map((item) => (
        <li key={item.title}>
          <TrustItem {...item} />
        </li>
      ))}
    </ul>
  );
}
