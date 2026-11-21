"use client";

import { type ComponentPropsWithRef, type FormEvent, useState } from "react";
import { Button } from "../../atoms/Button";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export const DECISION_REASON_LIMITS = { min: 5, max: 500 } as const;

export type DecisionOption<V extends string> = {
  value: V;
  label: string;
  variant?: "primary" | "secondary" | "danger";
};

export type DecisionFormProps<V extends string> = Omit<
  ComponentPropsWithRef<"form">,
  "onSubmit" | "children"
> & {
  /** Names the form, e.g. "Decision on case 3". */
  label: string;
  options: readonly DecisionOption<V>[];
  onDecide: (value: V, reason: string) => void;
  /** Who reads the reason, e.g. "The seller will see this." */
  hint?: string;
  busy?: boolean;
  error?: string | null;
};

const length = (text: string) => [...text.trim()].length;

/** A required reason and one button per outcome. Nothing is sent until the reason is long enough. */
export function DecisionForm<V extends string>({
  label,
  options,
  onDecide,
  hint = "",
  busy = false,
  error = null,
  className,
  ...props
}: DecisionFormProps<V>) {
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const n = length(reason);
  const problem =
    n < DECISION_REASON_LIMITS.min
      ? `Give a reason of at least ${DECISION_REASON_LIMITS.min} characters.`
      : n > DECISION_REASON_LIMITS.max
        ? `Use ${DECISION_REASON_LIMITS.max} characters or fewer.`
        : null;

  function decide(value: V) {
    setShown(true);
    if (problem) return;
    onDecide(value, reason.trim());
  }

  return (
    <form
      aria-label={label}
      noValidate
      onSubmit={(event: FormEvent) => event.preventDefault()}
      className={cn("flex flex-col gap-3 font-body", className)}
      {...props}
    >
      <FormField
        label="Reason"
        required
        hint={`${n} of ${DECISION_REASON_LIMITS.max} characters.${hint ? ` ${hint}` : ""}`}
        error={shown ? problem : null}
      >
        {(control) => (
          <Textarea {...control} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            variant={o.variant ?? "primary"}
            disabled={busy}
            aria-label={`${o.label}: ${label}`}
            onClick={() => decide(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </form>
  );
}
