"use client";

import { Check, ChevronDown } from "lucide-react";
import { type ComponentPropsWithRef, type KeyboardEvent, useEffect, useId, useRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { useDismissable } from "../../lib/useDismissable";

export type SortOption = { key: string; label: string };

export type SortMenuProps = Omit<ComponentPropsWithRef<"div">, "children" | "onChange"> & {
  /** Text before the chosen option, "Sort by". */
  label?: string;
  options: readonly SortOption[];
  /** Key of the chosen option. */
  value: string;
  onChange: (key: string) => void;
};

/**
 * A "Sort by: Best match" pill that opens a menu of radio items. Arrow keys, Home and End move
 * through the items, Enter or Space chooses one and closes the menu, Escape closes it and returns
 * focus to the pill. It only reports the choice; the page does the sorting.
 */
export function SortMenu({
  label = "Sort by",
  options,
  value,
  onChange,
  className,
  ...props
}: SortMenuProps) {
  const menuId = useId();
  const { open, setOpen, close, trigger, rootProps } = useDismissable();
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.find((option) => option.key === value) ?? options[0];

  // when the menu opens, focus the chosen item so the arrows start from it
  useEffect(() => {
    if (!open) return;
    const index = Math.max(
      options.findIndex((option) => option.key === value),
      0,
    );
    items.current[index]?.focus();
  }, [open, options, value]);

  function onMenuKeyDown(event: KeyboardEvent) {
    const list = items.current.filter((el): el is HTMLButtonElement => el !== null);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Tab") setOpen(false);
  }

  return (
    <div className={cn("relative", className)} {...props} {...rootProps}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-touch items-center justify-center gap-1.5 rounded-pill border border-fg bg-surface px-4 font-body text-sm font-semibold text-fg transition-colors duration-fast hover:bg-action-soft"
      >
        <span>
          {label}: <span className="font-bold">{chosen?.label}</span>
        </span>
        <Icon icon={ChevronDown} size={18} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface py-2 text-fg shadow-overlay"
        >
          {options.map((option, index) => {
            const selected = option.key === value;
            return (
              <button
                key={option.key}
                ref={(el) => {
                  items.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={-1}
                onClick={() => {
                  onChange(option.key);
                  close(true);
                }}
                className="flex min-h-touch w-full items-center justify-between gap-3 px-4 text-left font-body text-base hover:bg-surface-raised"
              >
                <span className={selected ? "font-bold" : undefined}>{option.label}</span>
                {selected ? <Icon icon={Check} size={18} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
