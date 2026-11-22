"use client";

import {
  ADDRESS_LABELS,
  ADDRESS_RULES,
  type AddressField,
  type AddressLabel,
  DomainError,
  INDIA_REGIONS,
  validateAddress,
} from "@delulu/core";
import { type ComponentPropsWithRef, type FormEvent, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { Checkbox } from "../../atoms/Checkbox";
import { Input } from "../../atoms/Input";
import { Select } from "../../atoms/Select";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export type AddressFormValues = {
  label: AddressLabel;
  address: {
    recipientName: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: "IN";
  };
  makeDefault: boolean;
};

export type AddressFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  initial?: Partial<Omit<AddressFormValues, "address">> & { address?: Partial<AddressFormValues["address"]> };
  onSubmit: (values: AddressFormValues) => void;
  onCancel?: () => void;
  submitLabel?: string;
  pending?: boolean;
  /** A message for the whole form (from the server). */
  error?: string | null;
  /** Per-field messages from the server, e.g. after screening. */
  fieldErrors?: Partial<Record<AddressField, string>>;
  /** Offer "Use as my default address" (hidden when editing the default). */
  showMakeDefault?: boolean;
};

/** PRD R5.2: the notice shown wherever an address is entered. */
export const ADDRESS_NOTICE =
  "Nothing will be delivered to this address. It is used only to make checkout and tracking feel real, and only you can see it: it is stored encrypted and never shown to sellers. You can use a fictional spot instead.";

const LABEL_NAMES: Record<AddressLabel, string> = { HOME: "Home", WORK: "Work", OTHER: "Other" };

const MESSAGES: Record<string, string> = {
  REQUIRED: "This is required.",
  TOO_LONG: "This is too long.",
  CHARACTERS: "Remove the unusual characters.",
  DIGITS: "Remove the long number. Addresses here never include a phone or card number.",
  INVALID: "Check this.",
  UNSUPPORTED: "Only addresses in India for now.",
};

const FIELD_MESSAGES: Partial<Record<AddressField, Partial<Record<string, string>>>> = {
  postalCode: { INVALID: "Enter a 6-digit PIN code." },
  state: { INVALID: "Choose a state or union territory." },
};

function problemsToMessages(error: unknown): Partial<Record<AddressField, string>> {
  if (!(error instanceof DomainError)) return {};
  const issues = (error.details.issues ?? []) as { field: AddressField; code: string }[];
  const out: Partial<Record<AddressField, string>> = {};
  for (const i of issues) {
    out[i.field] ??= FIELD_MESSAGES[i.field]?.[i.code] ?? MESSAGES[i.code] ?? "Check this.";
  }
  return out;
}

/**
 * A real delivery address (India only for now): label, recipient, two lines, city, state and PIN code.
 * No phone, no map, no lookup. Address autocomplete hints only; never a payment field.
 */
export function AddressForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = "Save address",
  pending = false,
  error,
  fieldErrors,
  showMakeDefault = true,
  className,
  ...props
}: AddressFormProps) {
  const id = useId();
  const [label, setLabel] = useState<AddressLabel>(initial?.label ?? "HOME");
  const [values, setValues] = useState({
    recipientName: initial?.address?.recipientName ?? "",
    line1: initial?.address?.line1 ?? "",
    line2: initial?.address?.line2 ?? "",
    city: initial?.address?.city ?? "",
    state: initial?.address?.state ?? "",
    postalCode: initial?.address?.postalCode ?? "",
  });
  const [makeDefault, setMakeDefault] = useState(initial?.makeDefault ?? false);
  const [local, setLocal] = useState<Partial<Record<AddressField, string>>>({});
  const errors = { ...fieldErrors, ...local };

  const set = (field: keyof typeof values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (local[field]) setLocal((l) => ({ ...l, [field]: undefined }));
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      validateAddress({ ...values, country: "IN" });
    } catch (e) {
      const messages = problemsToMessages(e);
      setLocal(messages);
      const first = Object.keys(messages)[0];
      const control = first ? event.currentTarget.elements.namedItem(first) : null;
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setLocal({});
    onSubmit({ label, address: { ...values, country: "IN" }, makeDefault });
  }

  const text = (
    field: Exclude<keyof typeof values, "state">,
    name: string,
    autoComplete: string,
    max: number,
    required = true,
    hint?: string,
  ) => (
    <FormField label={name} required={required} error={errors[field]} {...(hint ? { hint } : {})}>
      {(control) => (
        <Input
          {...control}
          name={field}
          autoComplete={autoComplete}
          maxLength={max}
          value={values[field]}
          onChange={(e) => set(field)(e.target.value)}
        />
      )}
    </FormField>
  );

  return (
    <form noValidate onSubmit={submit} className={cn("flex flex-col gap-4 font-body", className)} {...props}>
      <Alert tone="info" title="Nothing real ships">
        {ADDRESS_NOTICE}
      </Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <fieldset className="flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-sm font-medium text-fg">Label</legend>
        <div className="flex flex-wrap gap-2">
          {ADDRESS_LABELS.map((l) => (
            <label
              key={l}
              className="inline-flex min-h-touch cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 has-[:checked]:border-action has-[:checked]:bg-action-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
            >
              <input
                type="radio"
                name={`${id}-label`}
                value={l}
                checked={label === l}
                onChange={() => setLabel(l)}
                className="size-5 shrink-0 accent-action"
              />
              {LABEL_NAMES[l]}
            </label>
          ))}
        </div>
      </fieldset>
      {text("recipientName", "Recipient name", "name", ADDRESS_RULES.nameMaxChars)}
      {text(
        "line1",
        "Address line 1",
        "address-line1",
        ADDRESS_RULES.lineMaxChars,
        true,
        "Flat, house number, building, street",
      )}
      {text(
        "line2",
        "Address line 2 (optional)",
        "address-line2",
        ADDRESS_RULES.lineMaxChars,
        false,
        "Area, locality",
      )}
      {text("city", "City or town", "address-level2", ADDRESS_RULES.cityMaxChars)}
      <FormField label="State or union territory" required error={errors.state}>
        {(control) => (
          <Select
            {...control}
            name="state"
            autoComplete="address-level1"
            value={values.state}
            onChange={(e) => set("state")(e.target.value)}
          >
            <option value="">Choose…</option>
            {INDIA_REGIONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label="PIN code"
        required
        error={errors.postalCode}
        hint="Six digits. Checked for format only."
      >
        {(control) => (
          <Input
            {...control}
            name="postalCode"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={7}
            value={values.postalCode}
            onChange={(e) => set("postalCode")(e.target.value)}
          />
        )}
      </FormField>
      <p className="text-sm text-fg-muted">Country: India</p>
      {showMakeDefault ? (
        <Checkbox
          label="Use as my default address"
          checked={makeDefault}
          onChange={(e) => setMakeDefault(e.target.checked)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
