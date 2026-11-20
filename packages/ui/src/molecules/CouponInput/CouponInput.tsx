"use client";

import { type FormEvent, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { cn } from "../../lib/cn";

export type CouponInputProps = {
  onApply: (code: string) => void;
  onRemove?: () => void;
  /** When set, the applied state is shown instead of the input. */
  appliedCode?: string;
  error?: string;
  loading?: boolean;
  className?: string;
};

export function CouponInput({ onApply, onRemove, appliedCode, error, loading, className }: CouponInputProps) {
  const [code, setCode] = useState("");
  const errorId = useId();
  if (appliedCode) {
    return (
      <div
        className={cn(
          "flex min-h-touch items-center justify-between gap-2 rounded-md border border-success bg-success-soft px-3 font-body",
          className,
        )}
      >
        <span className="text-sm text-fg">
          Coupon <strong className="font-mono">{appliedCode}</strong> applied
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove coupon ${appliedCode}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    );
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed) onApply(trimmed);
  }
  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-1", className)}>
      <div className="flex gap-2">
        <Input
          aria-label="Coupon code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="secondary" loading={loading} className="shrink-0">
          Apply
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="font-body text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
