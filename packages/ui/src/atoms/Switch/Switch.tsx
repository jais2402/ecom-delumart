"use client";

import { type ComponentPropsWithRef, useState } from "react";
import { cn } from "../../lib/cn";

export type SwitchProps = Omit<ComponentPropsWithRef<"button">, "onChange" | "role" | "children"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  className,
  onClick,
  type,
  ...props
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isOn = checked ?? internal;
  return (
    <button
      type={type ?? "button"}
      role="switch"
      aria-checked={isOn}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        const next = !isOn;
        if (checked === undefined) setInternal(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        "inline-flex min-h-touch min-w-touch items-center justify-center disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-block h-6 w-11 rounded-pill border border-border-strong transition-colors duration-fast",
          isOn ? "bg-action" : "bg-surface",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-5 rounded-pill transition-transform duration-fast",
            isOn ? "translate-x-5 bg-fg-on-action" : "bg-fg-muted",
          )}
        />
      </span>
    </button>
  );
}
