import { Check } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type StepIndicatorProps = Omit<ComponentPropsWithRef<"ol">, "children"> & {
  steps: readonly string[];
  /** Zero-based index of the current step. */
  current: number;
};

/** Numbered circles joined by a line: done steps are filled with a tick, the current one is ringed. */
export function StepIndicator({ steps, current, className, ...props }: StepIndicatorProps) {
  return (
    <ol className={cn("flex w-full items-start font-body text-xs sm:text-sm", className)} {...props}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 text-center"
          >
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-4 right-1/2 h-0.5 w-full -translate-y-1/2",
                  index <= current ? "bg-action" : "bg-border",
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-pill border-2 text-sm font-bold",
                done && "border-action bg-action text-fg-on-action",
                active && "border-action bg-action text-fg-on-action ring-4 ring-action-soft",
                !done && !active && "border-border-strong bg-surface text-fg-muted",
              )}
            >
              {done ? <Check className="size-4" /> : index + 1}
            </span>
            <span
              className={cn("break-words", active ? "font-bold text-fg" : done ? "text-fg" : "text-fg-muted")}
            >
              {step}
              {done ? <VisuallyHidden> (completed)</VisuallyHidden> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
