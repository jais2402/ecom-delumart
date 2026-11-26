import { type ComponentPropsWithRef, useId } from "react";
import { cn } from "../../lib/cn";

export type PaymentMethodOptionProps = Omit<ComponentPropsWithRef<"input">, "type" | "children"> & {
  methodName: string;
  description?: string;
  /** When set, the option is disabled and this reason is shown. */
  disabledReason?: string;
};

export function PaymentMethodOption({
  methodName,
  description,
  disabledReason,
  className,
  ...props
}: PaymentMethodOptionProps) {
  const reasonId = useId();
  return (
    <label
      className={cn(
        "flex min-h-touch cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-4 font-body has-[:checked]:border-action has-[:checked]:bg-action-soft has-[:checked]:ring-1 has-[:checked]:ring-action has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
        className,
      )}
    >
      <input
        type="radio"
        className="mt-0.5 size-5 shrink-0 accent-action"
        disabled={Boolean(disabledReason) || props.disabled}
        aria-describedby={disabledReason ? reasonId : undefined}
        {...props}
      />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-fg">{methodName}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
        {disabledReason ? (
          <span id={reasonId} className="text-sm font-medium text-danger">
            {disabledReason}
          </span>
        ) : null}
      </span>
    </label>
  );
}
