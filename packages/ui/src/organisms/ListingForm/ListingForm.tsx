"use client";

import { DEFAULT_PRICING_CONFIG, LISTING_RULES } from "@delulu/core";
import { type ComponentPropsWithRef, type FormEvent, type ReactNode, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Checkbox } from "../../atoms/Checkbox";
import { Heading } from "../../atoms/Heading";
import { Input } from "../../atoms/Input";
import { Price } from "../../atoms/Price";
import { Radio } from "../../atoms/Radio";
import { Select } from "../../atoms/Select";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";
import {
  type ListingField,
  type ListingFormValues,
  listingProblems,
  netOfFee,
  parseQuantity,
  parseRupees,
  priceReading,
  suggestedAltText,
} from "./listing-form-rules";

export type { ListingField, ListingFormValues, ListingMode } from "./listing-form-rules";

export type ListingFormCategory = { slug: string; name: string };

/**
 * "draft": every field is editable. "revise": a published listing, only the text and the picture
 * can change here (price, stock and delivery have their own actions). "locked": nothing can change.
 */
export type ListingFormMode = "draft" | "revise" | "locked";

export type ListingFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "onChange" | "children"> & {
  values: ListingFormValues;
  onChange: (values: ListingFormValues) => void;
  categories: readonly ListingFormCategory[];
  mode?: ListingFormMode;
  /** Why the form cannot be edited, shown at the top in plain words. */
  lockedReason?: ReactNode;
  /** Messages from the server per field, in plain words. */
  fieldErrors?: Partial<Record<ListingField, readonly string[]>>;
  /** Warehouse space; null while it is unknown. */
  warehouse?: { used: number; capacity: number } | null;
  feePercent?: number;
  standardDeliveryPaise?: bigint;
  /** Saves the draft (or, in "revise" mode, sends the revised text). Called only with valid values. */
  onSave: (values: ListingFormValues) => void;
  saveLabel?: string;
  /** Asks to submit for review. Called only with valid values; the page confirms with the person. */
  onSubmitForReview?: (values: ListingFormValues) => void;
  submitLabel?: string;
  busy?: boolean;
};

const NO_ERRORS: Partial<Record<ListingField, readonly string[]>> = {};
const length = (text: string) => [...text.trim()].length;
const R = LISTING_RULES;

function messageList(list: readonly string[]): ReactNode {
  return list.length === 0 ? undefined : (
    <span className="flex flex-col">
      {list.map((m) => (
        <span key={m}>{m}</span>
      ))}
    </span>
  );
}

function Counter({ value, max, min }: { value: string; max: number; min?: number }) {
  const n = length(value);
  return (
    <span>
      {n} of {max} characters{min ? ` (at least ${min})` : ""}
    </span>
  );
}

/**
 * The listing editor: every field of a player-made product with its limits, a price reading, the
 * fee note, stock mode with warehouse space, delivery options and the template picker. Controlled;
 * the page puts the live preview next to it. The server has the last word on every value.
 */
export function ListingForm({
  values,
  onChange,
  categories,
  mode = "draft",
  lockedReason,
  fieldErrors = NO_ERRORS,
  warehouse = null,
  feePercent = DEFAULT_PRICING_CONFIG.feePercent,
  standardDeliveryPaise = DEFAULT_PRICING_CONFIG.deliveryFeePaise.STANDARD,
  onSave,
  saveLabel = "Save draft",
  onSubmitForReview,
  submitLabel = "Submit for review",
  busy = false,
  className,
  ...props
}: ListingFormProps) {
  const [shown, setShown] = useState(false);
  const [edited, setEdited] = useState<Partial<Record<ListingField, boolean>>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const problems = listingProblems(values);
  const all = mode === "draft";
  const text = mode !== "locked";
  const editable = (field: ListingField) => (all ? true : text && field in TEXT_FIELDS);

  function set<K extends ListingField>(field: K, value: ListingFormValues[K]) {
    setEdited((current) => ({ ...current, [field]: true }));
    onChange({ ...values, [field]: value });
  }

  function errorsFor(field: ListingField): readonly string[] {
    const out: string[] = [];
    const local = problems[field];
    if (shown && local && editable(field)) out.push(local);
    if (!edited[field]) for (const m of fieldErrors[field] ?? []) if (!out.includes(m)) out.push(m);
    return out;
  }

  function firstBad(): ListingField | null {
    const order: ListingField[] = [
      "name",
      "hook",
      "description",
      "category",
      "altText",
      "priceRupees",
      "quantity",
    ];
    return order.find((f) => editable(f) && problems[f]) ?? null;
  }

  function validate(): boolean {
    setShown(true);
    const bad = firstBad();
    if (bad) {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${bad}"]`)?.focus();
      return false;
    }
    return true;
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "locked") return;
    if (validate()) onSave(values);
  }

  const price = parseRupees(values.priceRupees);
  const reading = priceReading(values.priceRupees);
  const net = price !== null && !problems.priceRupees ? netOfFee(price, feePercent) : null;
  const quantity = parseQuantity(values.quantity);
  const free = warehouse ? warehouse.capacity - warehouse.used : null;
  const fits = quantity !== null && free !== null ? quantity <= free : true;
  const suggestion = suggestedAltText(values.name);

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={save}
      aria-label="Listing editor"
      className={cn("flex flex-col gap-5 font-body", className)}
      {...props}
    >
      {mode === "locked" && lockedReason ? <Alert tone="info">{lockedReason}</Alert> : null}
      {mode === "revise" ? (
        <Alert tone="info">
          Only the name, tagline, description, picture text and template can change here. The current version
          stays live until the new one passes review.
        </Alert>
      ) : null}

      <section aria-labelledby="lf-about" className="flex flex-col gap-4">
        <Heading level={2} size="sm" id="lf-about">
          About the product
        </Heading>
        <FormField
          label="Name"
          required
          hint={<Counter value={values.name} max={R.name.max} min={R.name.min} />}
          error={messageList(errorsFor("name"))}
        >
          {(control) => (
            <Input
              {...control}
              data-field="name"
              value={values.name}
              disabled={!editable("name")}
              autoComplete="off"
              onChange={(e) => set("name", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Tagline (optional)"
          hint={<Counter value={values.hook} max={R.hook.max} />}
          error={messageList(errorsFor("hook"))}
        >
          {(control) => (
            <Input
              {...control}
              data-field="hook"
              value={values.hook}
              disabled={!editable("hook")}
              autoComplete="off"
              onChange={(e) => set("hook", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Description"
          required
          hint={<Counter value={values.description} max={R.description.max} min={R.description.min} />}
          error={messageList(errorsFor("description"))}
        >
          {(control) => (
            <Textarea
              {...control}
              data-field="description"
              rows={5}
              value={values.description}
              disabled={!editable("description")}
              onChange={(e) => set("description", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Category" required error={messageList(errorsFor("category"))}>
          {(control) => (
            <Select
              {...control}
              data-field="category"
              value={values.category}
              disabled={!editable("category")}
              onChange={(e) => set("category", e.target.value)}
            >
              <option value="">Choose a category</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </section>

      <section aria-labelledby="lf-picture" className="flex flex-col gap-4">
        <Heading level={2} size="sm" id="lf-picture">
          Picture
        </Heading>
        <FormField
          label="Template"
          hint={`Slide to change the colours of the generated picture. ${R.templateId.min} to ${R.templateId.max}.`}
        >
          {(control) => (
            <div className="flex items-center gap-3">
              <input
                {...control}
                type="range"
                data-field="templateId"
                min={R.templateId.min}
                max={R.templateId.max}
                step={1}
                value={values.templateId}
                disabled={!editable("templateId")}
                aria-valuetext={`Template ${values.templateId} of ${R.templateId.max}`}
                onChange={(e) => set("templateId", Number(e.target.value))}
                className="h-touch min-w-0 flex-1 accent-action disabled:cursor-not-allowed disabled:opacity-50"
              />
              <output htmlFor={control.id} className="w-10 text-right text-base tabular-nums text-fg">
                {values.templateId}
              </output>
            </div>
          )}
        </FormField>
        <FormField
          label="Picture description (for people who cannot see it)"
          hint={<Counter value={values.altText} max={R.altText.max} />}
          error={messageList(errorsFor("altText"))}
        >
          {(control) => (
            <div className="flex flex-col gap-2">
              <Textarea
                {...control}
                data-field="altText"
                rows={2}
                value={values.altText}
                disabled={!editable("altText")}
                onChange={(e) => set("altText", e.target.value)}
              />
              {editable("altText") && suggestion && values.altText.trim() !== suggestion ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => set("altText", suggestion)}
                >
                  Use suggestion: {suggestion}
                </Button>
              ) : null}
            </div>
          )}
        </FormField>
      </section>

      <section aria-labelledby="lf-price" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="lf-price">
          Price
        </Heading>
        <FormField
          label="Price in rupees"
          required
          hint="Whole rupees. Fictional money."
          error={messageList(errorsFor("priceRupees"))}
        >
          {(control) => (
            <Input
              {...control}
              data-field="priceRupees"
              inputMode="numeric"
              autoComplete="off"
              value={values.priceRupees}
              disabled={!editable("priceRupees")}
              onChange={(e) => set("priceRupees", e.target.value)}
            />
          )}
        </FormField>
        <p className="min-h-6 text-sm text-fg" aria-live="polite" data-testid="price-reading">
          {reading ?? ""}
        </p>
        <p className="text-sm text-fg-muted">
          You receive the price minus a {feePercent}% marketplace fee.
          {net ? (
            <>
              {" "}
              <span className="text-fg">
                Fee <Price amountPaise={net.feePaise} display="exact" className="text-sm" />, you receive{" "}
                <Price amountPaise={net.netPaise} display="exact" className="text-sm" />.
              </span>
            </>
          ) : null}
        </p>
      </section>

      <fieldset
        className="flex flex-col gap-3 border-0 p-0"
        disabled={!editable("inventoryMode")}
        data-field="inventoryMode"
      >
        <legend className="mb-1 font-display text-xl font-bold text-fg">Stock</legend>
        <Radio
          name="inventoryMode"
          value="STANDARD_STOCKED"
          checked={values.inventoryMode === "STANDARD_STOCKED"}
          onChange={() => set("inventoryMode", "STANDARD_STOCKED")}
          label="Standard: you can restock it later."
        />
        <Radio
          name="inventoryMode"
          value="EXCLUSIVE"
          checked={values.inventoryMode === "EXCLUSIVE"}
          onChange={() => set("inventoryMode", "EXCLUSIVE")}
          label="Exclusive edition: the supply is fixed forever once published."
        />
        <FormField
          label={values.inventoryMode === "EXCLUSIVE" ? "Edition supply" : "Units to stock"}
          required
          error={messageList(errorsFor("quantity"))}
          hint={
            warehouse && quantity !== null && !problems.quantity
              ? fits
                ? `Uses ${quantity} of your ${warehouse.capacity} slots; ${(free ?? 0) - quantity} free.`
                : `Uses ${quantity} slots but only ${Math.max(free ?? 0, 0)} of your ${warehouse.capacity} are free.`
              : warehouse
                ? `Your warehouse has ${warehouse.capacity - warehouse.used} of ${warehouse.capacity} slots free. Every unsold unit uses one.`
                : "Every unsold unit uses one warehouse slot."
          }
        >
          {(control) => (
            <Input
              {...control}
              data-field="quantity"
              inputMode="numeric"
              autoComplete="off"
              value={values.quantity}
              disabled={!editable("quantity")}
              onChange={(e) => set("quantity", e.target.value)}
            />
          )}
        </FormField>
        {!fits ? (
          <Alert tone="warning">
            That is more than your free space. Publishing will be refused unless you lower the quantity.
          </Alert>
        ) : null}
      </fieldset>

      <fieldset
        className="flex flex-col gap-1 border-0 p-0"
        disabled={!editable("offersExpress")}
        data-field="delivery"
      >
        <legend className="mb-1 font-display text-xl font-bold text-fg">Delivery</legend>
        <Checkbox
          checked={values.offersExpress}
          onChange={(e) => set("offersExpress", e.target.checked)}
          label="Offer Express delivery"
        />
        <Checkbox
          checked={values.freeStandardDelivery}
          onChange={(e) => set("freeStandardDelivery", e.target.checked)}
          label="Free Standard delivery for buyers"
        />
        {values.freeStandardDelivery ? (
          <p className="text-sm text-fg">
            You pay it: <Price amountPaise={standardDeliveryPaise} display="exact" className="text-sm" />{" "}
            comes out of your proceeds on every order.
          </p>
        ) : (
          <p className="text-sm text-fg-muted">
            Buyers pay for Standard delivery unless you choose to cover it.
          </p>
        )}
      </fieldset>

      {mode !== "locked" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant={onSubmitForReview ? "secondary" : "primary"} loading={busy}>
            {saveLabel}
          </Button>
          {onSubmitForReview ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                if (validate()) onSubmitForReview(values);
              }}
            >
              {submitLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

const TEXT_FIELDS: Partial<Record<ListingField, true>> = {
  name: true,
  hook: true,
  description: true,
  altText: true,
  templateId: true,
};
