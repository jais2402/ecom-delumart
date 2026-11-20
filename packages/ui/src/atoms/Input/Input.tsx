import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

/** Shared look for text-like form controls. */
export const fieldClasses =
  "min-h-touch w-full rounded-md border border-border-strong bg-surface px-3 font-body text-base text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger";

export type InputProps = ComponentPropsWithRef<"input"> & {
  invalid?: boolean;
};

export function Input({ className, invalid, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid ? true : props["aria-invalid"]}
      className={cn(fieldClasses, className)}
      {...props}
    />
  );
}
