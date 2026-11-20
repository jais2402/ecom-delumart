import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type StatProps = Omit<ComponentPropsWithRef<"dl">, "children"> & {
  label: ReactNode;
  value: ReactNode;
  /** e.g. "+4% vs last week". Keep the direction in the text. */
  change?: ReactNode;
  /** e.g. "As of 9:00 am". */
  asOf?: ReactNode;
};

export function Stat({ label, value, change, asOf, className, ...props }: StatProps) {
  return (
    <dl className={cn("flex flex-col gap-1 font-body", className)} {...props}>
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="font-display text-2xl font-bold text-fg">{value}</dd>
      {change ? <dd className="text-sm text-fg">{change}</dd> : null}
      {asOf ? <dd className="text-xs text-fg-muted">{asOf}</dd> : null}
    </dl>
  );
}
