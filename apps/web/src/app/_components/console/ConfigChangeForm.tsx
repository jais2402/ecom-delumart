"use client";

import type { ConfigKeySpec } from "@delulu/core";
import { Alert, Button, FormField, Input, Textarea } from "@delulu/ui";
import { type FormEvent, useState } from "react";
import { actionErrorText, inputToStoredValue, valueText } from "../../_lib/admin-actions";
import { api } from "../../_lib/api";

const REASON = { min: 5, max: 500 } as const;

/**
 * Proposes one change to an allow-listed configuration value. Nothing is applied now: the change
 * waits for its delay and can be cancelled from Pending actions. Money is typed in whole rupees and
 * sent as whole paise (a decimal string); the server and the database check the bounds again.
 */
export function ConfigChangeForm({
  spec,
  delayText,
  onProposed,
}: {
  spec: ConfigKeySpec;
  /** How long a change waits, in words ("24 h 0 min"). */
  delayText: string;
  onProposed: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unit = spec.kind === "paise" ? "whole rupees" : "whole percent";
  const stored = inputToStoredValue(spec, value.trim());
  const reasonLength = [...reason.trim()].length;
  const valueProblem =
    stored === null ? `Enter ${unit} from ${valueRange(spec, "min")} to ${valueRange(spec, "max")}.` : null;
  const reasonProblem =
    reasonLength < REASON.min
      ? `Give a reason of at least ${REASON.min} characters.`
      : reasonLength > REASON.max
        ? `Use ${REASON.max} characters or fewer.`
        : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    setError(null);
    if (stored === null || reasonProblem) return;
    setBusy(true);
    try {
      await api("/api/v1/admin/config", {
        method: "POST",
        body: { key: spec.key, value: stored, reason: reason.trim() },
      });
      setValue("");
      setReason("");
      setShown(false);
      onProposed(
        `Proposed: set ${spec.label} to ${valueText(spec, stored)}. It is applied after ${delayText}, unless you cancel it.`,
      );
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={`Change ${spec.label}`}
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3"
    >
      <FormField
        label={`New value (${unit})`}
        required
        hint={`Allowed: ${valueRange(spec, "min")} to ${valueRange(spec, "max")}.`}
        error={shown ? valueProblem : null}
      >
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label="Reason"
        required
        hint={`${reasonLength} of ${REASON.max} characters. It is kept in the audit log; no links or contact details.`}
        error={shown ? reasonProblem : null}
      >
        {(control) => (
          <Textarea {...control} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        type="submit"
        disabled={busy}
        className="self-start"
        aria-label={`Propose change: ${spec.label}`}
      >
        Propose change
      </Button>
    </form>
  );
}

function valueRange(spec: ConfigKeySpec, end: "min" | "max"): string {
  const bound = end === "min" ? spec.min : spec.max;
  return spec.kind === "paise" ? valueText(spec, bound.toString()) : `${bound}%`;
}
