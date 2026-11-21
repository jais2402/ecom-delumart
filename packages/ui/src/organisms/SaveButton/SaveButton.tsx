import { Heart } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { IconButton } from "../../atoms/IconButton";
import { cn } from "../../lib/cn";

export type SaveButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-label" | "onClick" | "children"> & {
  /** Name of the product; it is part of the button's accessible name. */
  productName: string;
  saved: boolean;
  onToggle: () => void;
};

/**
 * A heart toggle. The accessible name says what pressing it will do: "Save <product>" or "Remove
 * <product> from saved". The filled heart is never the only signal: the name changes too.
 */
export function SaveButton({ productName, saved, onToggle, className, ...props }: SaveButtonProps) {
  return (
    <IconButton
      aria-label={saved ? `Remove ${productName} from saved` : `Save ${productName}`}
      data-saved={saved}
      onClick={onToggle}
      className={cn(
        "border border-border-strong bg-surface",
        saved ? "text-action" : "text-fg-muted hover:text-action",
        className,
      )}
      {...props}
    >
      <Icon icon={Heart} fill={saved ? "currentColor" : "none"} />
    </IconButton>
  );
}
