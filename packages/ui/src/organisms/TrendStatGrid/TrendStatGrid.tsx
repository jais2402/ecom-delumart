import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { TrendStat, type TrendStatProps } from "../../molecules/TrendStat";

export type TrendStatGridItem = Pick<
  TrendStatProps,
  "label" | "value" | "current" | "previous" | "previousValue"
> & {
  key: string;
};

export type TrendStatGridProps = Omit<ComponentPropsWithRef<"ul">, "children"> & {
  stats: readonly TrendStatGridItem[];
};

/** A grid of totals, each with its change against the previous period. */
export function TrendStatGrid({ stats, className, ...props }: TrendStatGridProps) {
  return (
    <ul className={cn("grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4", className)} {...props}>
      {stats.map(({ key, ...stat }) => (
        <li key={key} className="min-w-0 rounded-lg border border-border bg-surface p-4">
          <TrendStat {...stat} />
        </li>
      ))}
    </ul>
  );
}
