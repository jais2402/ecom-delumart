"use client";

import { type ChangeEvent, type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { Input } from "../../atoms/Input";
import { Label } from "../../atoms/Label";
import { cn } from "../../lib/cn";

export type PinFieldProps = Omit<
  ComponentPropsWithRef<"input">,
  "type" | "inputMode" | "autoComplete" | "maxLength" | "children"
> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
};

/** Six-digit game PIN. Never a real card or UPI PIN. */
export function PinField({
  label = "Delulu PIN (game only)",
  hint = "Do not use the PIN of a real card or UPI app",
  error,
  id: idProp,
  className,
  onChange,
  ...props
}: PinFieldProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
    if (digits !== event.target.value) event.target.value = digits;
    onChange?.(event);
  }
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        pattern="[0-9]{6}"
        invalid={Boolean(error)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        className="font-mono tracking-widest"
        onChange={handleChange}
        {...props}
      />
      <p id={hintId} className="font-body text-sm text-fg-muted">
        {hint}
      </p>
      {error ? (
        <p id={errorId} className="font-body text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
