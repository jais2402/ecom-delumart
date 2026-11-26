import type { ComponentPropsWithRef, ReactNode } from "react";
import { Tag } from "../../atoms/Tag";
import { cn } from "../../lib/cn";

export type DestinationOption = {
  /** "FICTIONAL_SPOT" or a saved address id. */
  value: string;
  title: string;
  text: string;
  kind: "fictional" | "real";
  isDefault?: boolean;
};

export type DestinationChoiceProps = Omit<ComponentPropsWithRef<"fieldset">, "onChange" | "children"> & {
  name: string;
  options: readonly DestinationOption[];
  value: string;
  onChange: (value: string) => void;
  legend?: string;
  /** Shown under the options, e.g. a link to add an address. */
  footer?: ReactNode;
};

/** Where an order is delivered: the fictional spot or one of the player's saved addresses. */
export function DestinationChoice({
  name,
  options,
  value,
  onChange,
  legend = "Deliver to",
  footer,
  disabled,
  className,
  ...props
}: DestinationChoiceProps) {
  return (
    <fieldset
      disabled={disabled}
      className={cn("flex min-w-0 flex-col gap-2 border-0 p-0 font-body", className)}
      {...props}
    >
      <legend className="mb-1 text-sm font-medium text-fg">{legend}</legend>
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
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{option.title}</span>
              {option.isDefault ? <Tag>Default</Tag> : null}
              <Tag>{option.kind === "fictional" ? "Fictional spot" : "Real address"}</Tag>
            </span>
            <span className="break-words text-sm text-fg-muted">{option.text}</span>
          </span>
        </label>
      ))}
      {footer}
    </fieldset>
  );
}
