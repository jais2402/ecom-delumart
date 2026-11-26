import type { ComponentPropsWithRef } from "react";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type DeliveryOptionProps = Omit<ComponentPropsWithRef<"input">, "type" | "children"> & {
  speedName: string;
  /** e.g. "Arrives Tuesday". */
  arrival: string;
  /** Fee in paise; 0n or undefined shows "Free". */
  feePaise?: bigint;
};

export function DeliveryOption({ speedName, arrival, feePaise, className, ...props }: DeliveryOptionProps) {
  return (
    <label
      className={cn(
        "flex min-h-touch cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-4 font-body has-[:checked]:border-action has-[:checked]:bg-action-soft has-[:checked]:ring-1 has-[:checked]:ring-action has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        className,
      )}
    >
      <input type="radio" className="mt-0.5 size-5 shrink-0 accent-action" {...props} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
        <span className="flex flex-col">
          <span className="font-medium text-fg">{speedName}</span>
          <span className="text-sm text-fg-muted">{arrival}</span>
        </span>
        {feePaise && feePaise > 0n ? (
          <Price amountPaise={feePaise} display="exact" />
        ) : (
          <span className="font-semibold text-success">Free</span>
        )}
      </span>
    </label>
  );
}
