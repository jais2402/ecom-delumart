import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type PageContentsItem = { label: string; href: string };

export type PageContentsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  /** Names the landmark; "On this page" by default. */
  label?: string;
  items: readonly PageContentsItem[];
};

/** A short list of in-page links ("On this page"), wrapping onto several lines on narrow screens. */
export function PageContents({ label = "On this page", items, className, ...props }: PageContentsProps) {
  return (
    <nav aria-label={label} className={cn("rounded-lg bg-surface p-4 md:p-6", className)} {...props}>
      <p className="font-display text-lg font-bold text-fg">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-x-6">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="inline-flex min-h-touch items-center font-body text-base text-action underline underline-offset-2 hover:text-action-hover"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
