"use client";

import { type ComponentPropsWithRef, type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { useSettledValue } from "../../lib/useSettledValue";
import { FormField } from "../../molecules/FormField";

export type ShopIdentityValues = { handle: string; displayName: string; description: string };
export type ShopIdentityLimits = {
  handleMin: number;
  handleMax: number;
  nameMin: number;
  nameMax: number;
  descriptionMax: number;
};
type Field = keyof ShopIdentityValues;

export type ShopIdentityFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  initial?: ShopIdentityValues;
  limits: ShopIdentityLimits;
  /** The handle is shown but cannot be changed (editing an existing shop). */
  handleFixed?: boolean;
  /** Messages from the server per field, in plain words. */
  fieldErrors?: Partial<Record<Field, readonly string[]>>;
  onSubmit: (values: ShopIdentityValues) => void;
  loading?: boolean;
  submitLabel: string;
};

const NO_ERRORS: Partial<Record<Field, readonly string[]>> = {};
const length = (text: string) => [...text.trim()].length;

/** Why a handle is not acceptable yet, in words; null when its format is fine. */
export function handleProblem(handle: string, limits: ShopIdentityLimits): string | null {
  if (handle === "") return `Choose a handle of ${limits.handleMin} to ${limits.handleMax} characters.`;
  if (/[A-Z]/.test(handle)) return "Use lowercase letters only.";
  if (!/^[a-z0-9-]+$/.test(handle)) return "Use only lowercase letters, digits and hyphens.";
  if (handle.startsWith("-") || handle.endsWith("-")) return "Do not start or end with a hyphen.";
  if (handle.includes("--")) return "Do not use two hyphens in a row.";
  if (handle.length < limits.handleMin) return `Use at least ${limits.handleMin} characters.`;
  if (handle.length > limits.handleMax) return `Use ${limits.handleMax} characters or fewer.`;
  return null;
}

/** Handle, display name and description of a shop, checked as you type; the server has the last word. */
export function ShopIdentityForm({
  initial = { handle: "", displayName: "", description: "" },
  limits,
  handleFixed = false,
  fieldErrors = NO_ERRORS,
  onSubmit,
  loading = false,
  submitLabel,
  className,
  ...props
}: ShopIdentityFormProps) {
  const [values, setValues] = useState<ShopIdentityValues>(initial);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [edited, setEdited] = useState<Partial<Record<Field, boolean>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionCount = length(values.description);
  const settledCount = length(useSettledValue(values.description));

  // a fresh answer from the server makes its messages current again
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity of fieldErrors marks a new answer
  useEffect(() => setEdited({}), [fieldErrors]);

  const local: Record<Field, string | null> = {
    handle: handleFixed ? null : handleProblem(values.handle, limits),
    displayName:
      length(values.displayName) < limits.nameMin
        ? `Use at least ${limits.nameMin} characters.`
        : length(values.displayName) > limits.nameMax
          ? `Use ${limits.nameMax} characters or fewer.`
          : null,
    description:
      descriptionCount > limits.descriptionMax
        ? `Keep it to ${limits.descriptionMax} characters or fewer (${descriptionCount - limits.descriptionMax} too many).`
        : null,
  };

  function messages(field: Field): string[] {
    const out: string[] = [];
    // the handle is checked live once something is typed; the others once the field was left or submitted
    const showLocal = field === "handle" ? touched.handle || values.handle !== "" : touched[field];
    if (showLocal && local[field]) out.push(local[field] as string);
    if (!edited[field])
      for (const message of fieldErrors[field] ?? []) if (!out.includes(message)) out.push(message);
    return out;
  }

  function change(field: Field, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setEdited((current) => ({ ...current, [field]: true }));
  }

  function render(field: Field) {
    const list = messages(field);
    return list.length > 0 ? (
      <span className="flex flex-col">
        {list.map((message) => (
          <span key={message}>{message}</span>
        ))}
      </span>
    ) : undefined;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({ handle: true, displayName: true, description: true });
    const firstBad = (["handle", "displayName", "description"] as const).find((f) => local[f]);
    if (firstBad) {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${firstBad}"]`)?.focus();
      return;
    }
    onSubmit({
      handle: values.handle.trim(),
      displayName: values.displayName.trim(),
      description: values.description.trim(),
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      className={cn("flex flex-col gap-4 font-body", className)}
      {...props}
    >
      <FormField
        label="Shop handle"
        required={!handleFixed}
        hint={
          handleFixed ? (
            "The handle is fixed and cannot be changed."
          ) : (
            <>
              Lowercase letters, digits and hyphens, {limits.handleMin} to {limits.handleMax} characters.
              <br />
              Your shop address will be{" "}
              <span className="break-all font-mono">/store/{values.handle || "your-handle"}</span>
            </>
          )
        }
        error={render("handle")}
      >
        {(control) => (
          <Input
            {...control}
            data-field="handle"
            value={values.handle}
            readOnly={handleFixed}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => change("handle", event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, handle: true }))}
          />
        )}
      </FormField>
      <FormField
        label="Display name"
        required
        hint={`${limits.nameMin} to ${limits.nameMax} characters. This is shown on your shop page.`}
        error={render("displayName")}
      >
        {(control) => (
          <Input
            {...control}
            data-field="displayName"
            value={values.displayName}
            autoComplete="off"
            onChange={(event) => change("displayName", event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
          />
        )}
      </FormField>
      <FormField
        label="Description"
        hint="Optional. Tell visitors what your shop is about. No links or contact details."
        error={render("description")}
      >
        {(control) => (
          <Textarea
            {...control}
            data-field="description"
            rows={4}
            value={values.description}
            onChange={(event) => change("description", event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, description: true }))}
          />
        )}
      </FormField>
      <p aria-hidden="true" className="text-sm text-fg-muted">
        {descriptionCount} of {limits.descriptionMax} characters
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        Description: {settledCount} of {limits.descriptionMax} characters
      </p>
      <Button type="submit" loading={loading} className="self-start">
        {submitLabel}
      </Button>
    </form>
  );
}
