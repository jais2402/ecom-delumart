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

/** A quiet row of reassurances between two thin rules: icon, bold title, one line. */
export function TrustStrip({ items, label = "Good to know", className, ...props }: TrustStripProps) {
  return (
    <ul
      aria-label={label}
      className={cn("grid gap-6 rounded-lg bg-surface p-5 sm:grid-cols-2 md:p-6 lg:grid-cols-4", className)}
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
