import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type BreadcrumbItem = { label: string; href?: string };

export type BreadcrumbsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  items: readonly BreadcrumbItem[];
};

export function Breadcrumbs({ items, className, ...props }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={className} {...props}>
      <ol className="flex flex-wrap items-center gap-1 font-body text-sm">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={item.label} className="flex items-center gap-1">
              {item.href && !last ? (
                <a
                  href={item.href}
                  className={cn(
                    "inline-flex min-h-touch items-center text-action underline underline-offset-2",
                  )}
                >
                  {item.label}
                </a>
              ) : (
                <span aria-current={last ? "page" : undefined} className="text-fg">
                  {item.label}
                </span>
              )}
              {last ? null : <ChevronRight aria-hidden="true" className="size-4 text-fg-muted" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
