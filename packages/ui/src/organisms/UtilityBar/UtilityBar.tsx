import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type UtilityBarLink = { label: string; href: string };

export type UtilityBarProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** One plain, true statement, centred. It wraps rather than truncates on narrow screens. */
  message: string;
  /** Small links on the right, from 640px. Each tap area is taller than the strip, so it still meets the 44px target. */
  links?: readonly UtilityBarLink[];
};

/** A thin brand-coloured announcement strip above the header: one centred message and, on wide screens, two small links at the right. */
export function UtilityBar({ message, links = [], className, ...props }: UtilityBarProps) {
  return (
    <div className={cn("border-b border-border-on-band bg-band text-fg-on-band", className)} {...props}>
      <div className="mx-auto grid min-h-8 max-w-content grid-cols-1 items-center px-4 py-1 font-body text-xs sm:grid-cols-[1fr_auto_1fr] md:h-8 md:py-0">
        <span aria-hidden="true" className="hidden sm:block" />
        <p className="text-center">{message}</p>
        <ul className="hidden items-center justify-end gap-1 sm:flex">
          {links.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="-my-2 inline-flex h-11 items-center rounded-md px-2 text-fg-on-band underline-offset-2 hover:underline focus-visible:outline-fg-on-band"
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
