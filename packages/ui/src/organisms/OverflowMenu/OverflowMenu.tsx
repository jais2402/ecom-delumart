"use client";

import { MoreHorizontal } from "lucide-react";
import { type ComponentPropsWithRef, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type OverflowMenuItem = { label: string; onSelect: () => void };

export type OverflowMenuProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Accessible name of the button, e.g. "More actions". */
  label?: string;
  items: readonly OverflowMenuItem[];
};

/**
 * A "more actions" disclosure: a button that shows a short list of buttons. Escape or a click
 * outside closes it and Escape returns focus to the button. The list is plain buttons, not an ARIA
 * menu, so every item is an ordinary tab stop.
 */
export function OverflowMenu({ label = "More actions", items, className, ...props }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the whole disclosure; the controls inside are real buttons
    <div
      ref={root}
      className={cn("relative inline-block font-body", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      {...props}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-touch min-w-touch items-center justify-center gap-1 rounded-md border border-border-strong bg-surface px-3 text-fg hover:bg-action-soft"
      >
        <Icon icon={MoreHorizontal} />
        <span className="sr-only">{label}</span>
      </button>
      {open ? (
        <ul
          id={listId}
          aria-label={label}
          className="absolute right-0 z-10 mt-1 flex min-w-48 flex-col rounded-md border border-border bg-surface-raised p-1 shadow-overlay"
        >
          {items.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                className="flex min-h-touch w-full items-center rounded-sm px-3 text-left text-base text-fg hover:bg-action-soft"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
