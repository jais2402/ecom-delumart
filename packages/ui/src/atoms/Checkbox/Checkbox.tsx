import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type CheckboxProps = Omit<ComponentPropsWithRef<"input">, "type"> & {
  /** Visible label text. Omit only when supplying aria-label. */
  label?: ReactNode;
  invalid?: boolean;
};

/** Native checkbox inside a 44px label target. className applies to the input. */
export function Checkbox({ label, invalid, className, ...props }: CheckboxProps) {
  return (
    <label className="inline-flex min-h-touch items-center gap-2 font-body text-base text-fg">
      <input
        type="checkbox"
        aria-invalid={invalid ? true : props["aria-invalid"]}
        className={cn(
          "size-5 shrink-0 accent-action disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "outline outline-2 outline-danger",
          className,
        )}
        {...props}
      />
      {label}
    </label>
  );
}
