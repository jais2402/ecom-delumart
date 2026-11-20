import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type IconButtonProps = Omit<ComponentPropsWithRef<"button">, "aria-label"> & {
  /** Required: icon-only buttons need an accessible name. */
  "aria-label": string;
};

export function IconButton({ className, type, ...props }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "inline-flex min-h-touch min-w-touch items-center justify-center rounded-md text-fg transition-colors duration-fast hover:bg-action-soft disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
