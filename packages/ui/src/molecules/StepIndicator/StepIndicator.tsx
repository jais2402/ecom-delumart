import { Check } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type StepIndicatorProps = Omit<ComponentPropsWithRef<"ol">, "children"> & {
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
};

export function StepIndicator({ steps, current, className, ...props }: StepIndicatorProps) {
  return (
    <ol className={cn("flex flex-wrap gap-x-4 gap-y-2 font-body text-sm", className)} {...props}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex min-h-touch items-center gap-2",
              active ? "font-bold text-fg" : "text-fg-muted",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex size-6 items-center justify-center rounded-pill border text-xs",
                done && "border-action bg-action text-fg-on-action",
                active && "border-action text-action",
                !done && !active && "border-border-strong",
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            <span>
              {step}
              {done ? <VisuallyHidden> (completed)</VisuallyHidden> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
