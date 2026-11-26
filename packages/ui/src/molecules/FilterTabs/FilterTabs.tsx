import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type FilterOption = { key: string; label: string };

export type FilterTabsProps = Omit<ComponentPropsWithRef<"div">, "children" | "onChange"> & {
  /** Accessible name of the group, such as "Filter top picks by category". */
  label: string;
  options: readonly FilterOption[];
  /** Key of the pressed option. */
  value: string;
  onChange: (key: string) => void;
};

/** A row of toggle buttons where exactly one is pressed (aria-pressed). Each is a 44px button reachable by Tab; the row scrolls sideways inside itself on narrow screens. */
export function FilterTabs({ label, options, value, onChange, className, ...props }: FilterTabsProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form fields; this is a labelled group of toggle buttons
    <div
      role="group"
      aria-label={label}
      className={cn(
        "-mx-1 flex gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const pressed = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.key)}
            className={cn(
              "inline-flex min-h-touch shrink-0 items-center rounded-pill border px-4 font-body text-sm transition-colors duration-fast",
              pressed
                ? "border-action bg-action-soft font-semibold text-action"
                : "border-border-strong bg-surface text-fg hover:bg-action-soft",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
