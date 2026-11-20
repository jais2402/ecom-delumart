import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type ProgressBarProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  value: number;
  max?: number;
  /** Accessible name, e.g. "Order progress". */
  label: string;
};

export function ProgressBar({ value, max = 100, label, className, ...props }: ProgressBarProps) {
  const clamped = Math.min(Math.max(value, 0), max);
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={clamped}
      className={cn("h-2 w-full overflow-hidden rounded-pill bg-surface-raised", className)}
      {...props}
    >
      <div
        className="h-full rounded-pill bg-action transition-[width] duration-base"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
