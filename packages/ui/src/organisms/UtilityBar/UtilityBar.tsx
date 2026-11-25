import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type UtilityBarLink = { label: string; href: string };

export type UtilityBarProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Plain statements on the left. Below 640px only the first shows. */
  items: readonly string[];
  /** Small links on the right. Each tap area is taller than the bar, so it still meets the 44px target. */
  links?: readonly UtilityBarLink[];
};

/** A slim white row above the header: small plain statements and links. */
export function UtilityBar({ items, links = [], className, ...props }: UtilityBarProps) {
  return (
    <div className={cn("border-b border-border bg-surface text-fg-muted", className)} {...props}>
      <div className="mx-auto flex h-8 max-w-content items-center justify-between gap-4 px-4 font-body text-xs">
        <ul className="flex min-w-0 items-center gap-x-5 overflow-hidden">
          {items.map((item, index) => (
            <li key={item} className={cn("whitespace-nowrap", index > 0 && "hidden sm:block")}>
              {item}
            </li>
          ))}
        </ul>
        <ul className="hidden items-center gap-1 sm:flex">
          {links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="-my-2 inline-flex h-11 items-center rounded-md px-2 text-fg underline-offset-2 hover:underline"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
