"use client";

import { ChevronRight, Menu, X } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import type { CategoryLink } from "../../molecules/CategoryThumb";

export type CategoryMenuProps = {
  categories: readonly CategoryLink[];
  className?: string;
};

/**
 * The "Categories" button of the header and the panel it opens: one row per category with a
 * chevron. Escape closes it and puts focus back on the button; so does a click outside or moving
 * focus out. Below 768px the panel is a full-width sheet at the bottom of the screen.
 */
export function CategoryMenu({ categories, className }: CategoryMenuProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close(true);
    }
  }
  function onBlur(event: FocusEvent) {
    if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: handles Escape and focus leaving for the button and panel inside
    <div ref={root} className={cn("relative", className)} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md px-3 font-body text-base font-medium text-fg-on-band transition-colors duration-fast hover:bg-band-hover focus-visible:outline-fg-on-band"
      >
        <Icon icon={Menu} />
        <span className="sr-only md:not-sr-only">Categories</span>
      </button>
      {open ? (
        <>
          <div aria-hidden="true" className="fixed inset-0 z-40 bg-ink/50" />
          <nav
            id={panelId}
            aria-label="All categories"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border border-border bg-surface pb-[env(safe-area-inset-bottom)] text-fg shadow-overlay md:absolute md:inset-x-auto md:top-full md:bottom-auto md:left-0 md:mt-2 md:w-80 md:rounded-lg md:pb-0"
          >
            <div className="flex items-center justify-between border-b border-border px-4 md:hidden">
              <span className="font-body text-base font-bold">Categories</span>
              <button
                type="button"
                aria-label="Close categories"
                onClick={() => close(true)}
                className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-surface-raised"
              >
                <Icon icon={X} />
              </button>
            </div>
            <ul className="py-2">
              {categories.map((category) => (
                <li key={category.slug}>
                  <a
                    href={category.href}
                    className="flex min-h-touch items-center justify-between gap-3 px-4 font-body text-base hover:bg-surface-raised"
                  >
                    {category.name}
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
