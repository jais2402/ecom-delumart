import type { ComponentPropsWithRef } from "react";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type DeliveryChoiceOption = {
  /** The value handed back to onChange, e.g. "EXPRESS". */
  value: string;
  speedName: string;
  /** e.g. "Arrives in about 2 hours". */
  arrival: string;
  /** Fee in paise; 0n shows "Free"; null means it is not known until this speed is chosen. */
  feePaise: bigint | null;
};

export type DeliveryChoiceProps = Omit<ComponentPropsWithRef<"fieldset">, "onChange" | "children"> & {
  sellerName: string;
  /** Radio group name; unique per seller on the page. */
  name: string;
  options: readonly DeliveryChoiceOption[];
  value: string;
  onChange: (value: string) => void;
};

/** One seller's delivery speeds as a radio group. Only the speeds the seller offers are passed in. */
export function DeliveryChoice({
  sellerName,
  name,
  options,
  value,
  onChange,
  disabled,
  className,
  ...props
}: DeliveryChoiceProps) {
  return (
    <fieldset
      disabled={disabled}
      className={cn("flex min-w-0 flex-col gap-2 border-0 p-0 font-body", className)}
      {...props}
    >
      <legend className="mb-1 break-words text-sm font-medium text-fg">Delivery from {sellerName}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="flex min-h-touch cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-4 has-[:checked]:border-action has-[:checked]:bg-action-soft has-[:checked]:ring-1 has-[:checked]:ring-action has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-0.5 size-5 shrink-0 accent-action"
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3">
            <span className="flex flex-col">
              <span className="font-medium text-fg">{option.speedName}</span>
              <span className="text-sm text-fg-muted">{option.arrival}</span>
            </span>
            {option.feePaise === null ? (
              <span className="text-sm text-fg-muted">Fee shown once chosen</span>
            ) : option.feePaise > 0n ? (
              <Price amountPaise={option.feePaise} display="exact" />
            ) : (
              <span className="font-semibold text-success">Free</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
