import type { ComponentPropsWithRef } from "react";
import { ProgressBar } from "../../atoms/ProgressBar";
import { cn } from "../../lib/cn";

export type WarehouseUsageProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  used: number;
  capacity: number;
  /** What the warehouse is called, e.g. "Starter warehouse". */
  name?: string;
};

/** "0 of 100 used" with a bar; the text carries the numbers, the bar repeats them. */
export function WarehouseUsage({
  used,
  capacity,
  name = "Starter warehouse",
  className,
  ...props
}: WarehouseUsageProps) {
  return (
    <div className={cn("flex flex-col gap-2 font-body", className)} {...props}>
      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-base font-medium text-fg">{name}</span>
        <span className="text-base text-fg">
          {used} of {capacity} used
        </span>
      </p>
      <ProgressBar label={`${name} space used`} value={used} max={capacity} />
    </div>
  );
}
