import { X } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type TagProps = ComponentPropsWithRef<"span"> & {
  /** When given, a remove button is shown. */
  onRemove?: () => void;
  /** Accessible name of the remove button, e.g. "Remove Gadgets". */
  removeLabel?: string;
};

export function Tag({ onRemove, removeLabel = "Remove", className, children, ...props }: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-2 py-0.5 font-body text-sm text-fg",
        className,
      )}
      {...props}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="-my-2 -mr-2 inline-flex min-h-touch min-w-touch items-center justify-center rounded-sm hover:bg-action-soft"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  );
}
