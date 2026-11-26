"use client";

import { ChevronDown } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useId, useState } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type CollapsibleBlockProps = Omit<ComponentPropsWithRef<"div">, "title" | "children"> & {
  /** Accessible name of the toggle, e.g. "Order summary". */
  title: string;
  /** Shown at the right of the toggle, e.g. the total. */
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * A block that folds away on phones and tablets (a toggle with `aria-expanded`) and is always open
 * from 1024px, where the toggle disappears. The content is rendered once.
 */
export function CollapsibleBlock({
  title,
  hint,
  defaultOpen = false,
  className,
  children,
  ...props
}: CollapsibleBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-touch w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2 text-left font-body font-bold text-fg hover:bg-action-soft lg:hidden"
      >
        <span className="flex min-w-0 items-center gap-2">
          {title}
          <Icon
            icon={ChevronDown}
            size={18}
            className={cn(
              "transition-transform duration-fast motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </span>
        {hint ? <span className="shrink-0 font-normal">{hint}</span> : null}
      </button>
      <div id={bodyId} className={cn("mt-2 lg:mt-0 lg:block", open ? "block" : "hidden")}>
        {children}
      </div>
    </div>
  );
}
