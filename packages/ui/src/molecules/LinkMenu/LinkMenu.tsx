"use client";

import { ChevronDown, ChevronRight, X } from "lucide-react";
import { type ComponentPropsWithRef, useId } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { useDismissable } from "../../lib/useDismissable";

export type LinkMenuItem = { name: string; href: string };

export type LinkMenuProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Text of the pill button, such as "Departments". */
  label: string;
  /** Accessible name of the panel of links. */
  panelLabel: string;
  links: readonly LinkMenuItem[];
};

/**
 * A pill button with a chevron that opens a panel of links, one row each. Escape closes it and puts
 * focus back on the button; so does a press outside or moving focus out. Below 768px the panel is a
 * full-width sheet at the bottom of the screen with its own close button.
 */
export function LinkMenu({ label, panelLabel, links, className, ...props }: LinkMenuProps) {
  const panelId = useId();
  const { open, setOpen, close, trigger, rootProps } = useDismissable();
  return (
    <div className={cn("relative", className)} {...props} {...rootProps}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-touch shrink-0 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-4 font-body text-sm font-bold text-fg transition-colors duration-fast hover:bg-action-soft"
      >
        {label}
        <Icon icon={ChevronDown} size={18} />
      </button>
      {open ? (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-40 bg-ink/50 md:hidden" />
          <nav
            id={panelId}
            aria-label={panelLabel}
            className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border border-border bg-surface pb-[env(safe-area-inset-bottom)] text-fg shadow-overlay md:absolute md:inset-x-auto md:top-full md:bottom-auto md:left-0 md:mt-2 md:w-72 md:rounded-lg md:pb-0"
          >
            <div className="flex items-center justify-between border-b border-border px-4 md:hidden">
              <span className="font-body text-base font-bold">{label}</span>
              <button
                type="button"
                aria-label={`Close ${label.toLowerCase()}`}
                onClick={() => close(true)}
                className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-pill hover:bg-surface-raised"
              >
                <Icon icon={X} />
              </button>
            </div>
            <ul className="py-2">
              {links.map((link) => (
                <li key={link.href + link.name}>
                  <a
                    href={link.href}
                    className="flex min-h-touch items-center justify-between gap-3 px-4 font-body text-base hover:bg-surface-raised"
                  >
                    {link.name}
                    <Icon icon={ChevronRight} size={18} className="text-fg-muted" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </>
      ) : null}
    </div>
  );
}
