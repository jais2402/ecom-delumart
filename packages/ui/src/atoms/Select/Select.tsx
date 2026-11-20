import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { fieldClasses } from "../Input";

export type SelectProps = ComponentPropsWithRef<"select"> & {
  invalid?: boolean;
};

/** Native select; options are passed as children. */
export function Select({ className, invalid, ...props }: SelectProps) {
  return (
    <select
      aria-invalid={invalid ? true : props["aria-invalid"]}
      className={cn(fieldClasses, className)}
      {...props}
    />
  );
}
