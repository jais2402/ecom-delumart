import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { fieldClasses } from "../Input";

export type TextareaProps = ComponentPropsWithRef<"textarea"> & {
  invalid?: boolean;
};

export function Textarea({ className, invalid, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid ? true : props["aria-invalid"]}
      className={cn(fieldClasses, "py-2", className)}
      {...props}
    />
  );
}
