import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Stat } from "../../molecules/Stat";

export type StatGridItem = { label: string; value: ReactNode; change?: ReactNode; asOf?: ReactNode };

export type StatGridProps = Omit<ComponentPropsWithRef<"ul">, "children"> & {
  stats: readonly StatGridItem[];
};

export function StatGrid({ stats, className, ...props }: StatGridProps) {
  return (
    <ul className={cn("grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4", className)} {...props}>
      {stats.map((stat) => (
        <li key={stat.label} className="min-w-0 rounded-lg border border-border bg-surface p-4">
          <Stat
            label={stat.label}
            value={stat.value}
            {...(stat.change ? { change: stat.change } : {})}
            {...(stat.asOf ? { asOf: stat.asOf } : {})}
          />
        </li>
      ))}
    </ul>
  );
}
