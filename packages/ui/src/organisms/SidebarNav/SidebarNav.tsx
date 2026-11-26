import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type SidebarNavItem = { label: string; href: string; icon?: LucideIcon };

export type SidebarNavProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  /** Accessible name of the navigation. */
  label: string;
  items: readonly SidebarNavItem[];
  /** href of the current page. */
  currentHref?: string;
  /** "pills": a row of pills that scrolls sideways on phones, a vertical list from 768px. */
  layout?: "stacked" | "pills";
};

export function SidebarNav({
  label,
  items,
  currentHref,
  layout = "stacked",
  className,
  ...props
}: SidebarNavProps) {
  const pills = layout === "pills";
  return (
    <nav aria-label={label} className={cn("font-body", className)} {...props}>
      <ul
        className={cn(
          "flex gap-1",
          pills
            ? "snap-x overflow-x-auto p-1 md:snap-none md:flex-col md:overflow-visible md:p-0"
            : "flex-col",
        )}
      >
        {items.map((item) => {
          const current = item.href === currentHref;
          return (
            <li key={item.href} className={pills ? "shrink-0 snap-start md:shrink" : undefined}>
              <a
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-touch items-center gap-2 text-base text-fg hover:bg-action-soft",
                  pills
                    ? "whitespace-nowrap rounded-pill border border-border bg-surface px-4 md:rounded-md md:border-0 md:bg-transparent md:px-3"
                    : "rounded-md px-3",
                  current &&
                    (pills
                      ? "border-action bg-action-soft font-bold text-action md:border-0 md:border-l-4 md:border-l-action md:rounded-l-none"
                      : "bg-action-soft font-bold"),
                )}
              >
                {item.icon ? <Icon icon={item.icon} /> : null}
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
