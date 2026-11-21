import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { Stat } from "../Stat";

export type Trend = { direction: "up" | "down" | "flat" | "none"; text: string };

/**
 * Change of `current` against `previous`, in whole bigint arithmetic (these can be paise).
 * Direction is always in the text; a previous value of zero or none has nothing to compare with.
 */
export function describeTrend(current: bigint | null, previous: bigint | null): Trend {
  if (previous === null || previous === 0n) return { direction: "none", text: "No earlier data" };
  if (current === null) return { direction: "none", text: "No data this period" };
  const delta = current - previous;
  if (delta === 0n) return { direction: "flat", text: "No change vs previous period" };
  const abs = delta < 0n ? -delta : delta;
  const base = previous < 0n ? -previous : previous;
  const tenths = (abs * 2000n + base) / (2n * base); // tenths of a percent, rounded half up
  const pct = `${tenths / 10n}.${tenths % 10n}%`;
  return delta > 0n
    ? { direction: "up", text: `Up ${pct} vs previous period` }
    : { direction: "down", text: `Down ${pct} vs previous period` };
}

export type TrendStatProps = Omit<ComponentPropsWithRef<"dl">, "children"> & {
  label: ReactNode;
  /** The formatted value shown large. */
  value: ReactNode;
  current: bigint | null;
  previous: bigint | null;
  /** The formatted previous value, shown after the change. */
  previousValue?: ReactNode;
};

const glyph = { up: ArrowUp, down: ArrowDown, flat: Minus, none: Minus } as const;

/** A Stat whose change line pairs an arrow with words, never colour alone. */
export function TrendStat({
  label,
  value,
  current,
  previous,
  previousValue,
  className,
  ...props
}: TrendStatProps) {
  const trend = describeTrend(current, previous);
  return (
    <Stat
      label={label}
      value={value}
      className={cn(className)}
      change={
        <span data-trend={trend.direction} className="flex flex-wrap items-center gap-x-1">
          <span className="inline-flex items-center gap-1">
            <Icon icon={glyph[trend.direction]} size={16} className="shrink-0" />
            <span>{trend.text}</span>
          </span>
          {trend.direction !== "none" && previousValue ? (
            <span className="text-fg-muted">(was {previousValue})</span>
          ) : null}
        </span>
      }
      {...props}
    />
  );
}
