import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { VisuallyHidden } from "../VisuallyHidden";

export type LabelProps = ComponentPropsWithRef<"label"> & {
  required?: boolean;
};

export function Label({ className, required, children, ...props }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is supplied by the caller
    <label className={cn("font-body text-sm font-medium text-fg", className)} {...props}>
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="ml-1 text-danger">
            *
          </span>
          <VisuallyHidden> (required)</VisuallyHidden>
        </>
      ) : null}
    </label>
  );
}
