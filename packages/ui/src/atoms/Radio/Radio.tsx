import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type RadioProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  label?: ReactNode;
};

/** Native radio inside a 44px label target. className applies to the input. */
export function Radio({ label, className, ...props }: RadioProps) {
  return (
    <label className="inline-flex min-h-touch items-center gap-2 font-body text-base text-fg">
      <input
        type="radio"
        className={cn(
          "size-5 shrink-0 accent-action disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
      {label}
    </label>
  );
}
