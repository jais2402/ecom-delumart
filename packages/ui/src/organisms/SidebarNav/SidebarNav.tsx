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
};

export function SidebarNav({ label, items, currentHref, className, ...props }: SidebarNavProps) {
  return (
    <nav aria-label={label} className={cn("font-body", className)} {...props}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const current = item.href === currentHref;
          return (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-touch items-center gap-2 rounded-md px-3 text-base text-fg hover:bg-action-soft",
                  current && "bg-action-soft font-bold",
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
