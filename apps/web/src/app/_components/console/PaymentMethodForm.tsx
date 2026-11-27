"use client";

import { Alert, Button, FormField, Input, Switch, Textarea } from "@delulu/ui";
import { type FormEvent, useId, useState } from "react";
import { api } from "../../_lib/api";
import {
  type AdminMethod,
  buildChange,
  formFromCurrent,
  type MethodFormField,
  type MethodFormInput,
  methodErrorText,
  methodLabel,
  ORDER_RANGE,
  REASON_RANGE,
} from "../../_lib/payment-methods-admin";

/** The browser moves focus to the inner date fields, so the outer input needs its own ring. */
const DATE_FOCUS =
  "focus:outline-2 focus:outline-solid focus:outline-focus focus:outline-offset-2 focus-within:outline-2 focus-within:outline-solid focus-within:outline-focus focus-within:outline-offset-2";

/**
 * Proposes a change to one payment method. Nothing is applied now: the change joins the delayed
 * queue and can be cancelled from Pending actions. The server judges the end state and its refusal is
 * shown here in words. The form starts from the current settings, so only what is edited differs.
 */
export function PaymentMethodForm({
  method,
  delayText,
  onProposed,
}: {
  method: AdminMethod;
  /** How long a change waits, in words ("24 h 0 min"). */
  delayText: string;
  onProposed: (text: string) => void;
}) {
  const label = methodLabel(method.method);
  const switchLabelId = useId();
  const [input, setInput] = useState<MethodFormInput>(() => formFromCurrent(method));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = buildChange(method.method, input);
  const problems: Partial<Record<MethodFormField, string>> = shown && !checked.ok ? checked.problems : {};
  const set = (patch: Partial<MethodFormInput>) => setInput((current) => ({ ...current, ...patch }));
  const reasonLength = [...input.reason.trim()].length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setShown(true);
    setError(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      await api("/api/v1/admin/payment-methods", { method: "POST", body: checked.body });
      setInput(formFromCurrent(method));
      setShown(false);
      onProposed(`Proposed a change to ${label}. It is applied after ${delayText}, unless you cancel it.`);
    } catch (e) {
      setError(methodErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={`Change ${label}`}
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span id={switchLabelId} className="min-w-0 text-fg">
          Offer this method at checkout
        </span>
        <Switch
          aria-labelledby={switchLabelId}
          checked={input.enabled}
          onCheckedChange={(on) => set({ enabled: on })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          label="Position in the list"
          required
          hint={`${ORDER_RANGE.min} is shown first.`}
          error={problems.displayOrder ?? null}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={input.displayOrder}
              onChange={(e) => set({ displayOrder: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          label="Limit per payment (whole rupees)"
          hint="Empty means no limit."
          error={problems.perAttempt ?? null}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={input.perAttempt}
              onChange={(e) => set({ perAttempt: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          label="Limit per day (whole rupees)"
          hint="Per customer. Empty means no limit."
          error={problems.perDay ?? null}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="off"
              value={input.perDay}
              onChange={(e) => set({ perDay: e.target.value })}
            />
          )}
        </FormField>
      </div>
      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-bold text-fg">Maintenance window (India time)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Starts" error={problems.from ?? null}>
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                className={DATE_FOCUS}
                value={input.from}
                onChange={(e) => set({ from: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Ends" error={problems.until ?? null}>
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                className={DATE_FOCUS}
                value={input.until}
                onChange={(e) => set({ until: e.target.value })}
              />
            )}
          </FormField>
        </div>
        <p className="text-sm text-fg-muted">
          During the window customers see the method as unavailable. Leave both empty for none.
        </p>
      </fieldset>
      <FormField
        label="Reason"
        required
        hint={`${reasonLength} of ${REASON_RANGE.max} characters. It is kept in the audit log; no links or contact details.`}
        error={problems.reason ?? null}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            value={input.reason}
            onChange={(e) => set({ reason: e.target.value })}
          />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" disabled={busy} className="self-start" aria-label={`Propose change: ${label}`}>
        Propose change
      </Button>
    </form>
  );
}
