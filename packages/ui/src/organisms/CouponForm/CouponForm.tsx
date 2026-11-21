"use client";

import { type ComponentPropsWithRef, type FormEvent, useState } from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { Radio } from "../../atoms/Radio";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export type CouponRequest = {
  kind: "PERCENT" | "FLAT";
  /** Whole percent, or whole rupees for a flat coupon. */
  value: number;
  minSpendRupees?: number;
  startsAt?: string;
  endsAt?: string;
  maxRedemptions?: number;
  isPublic: boolean;
  publicCode?: string;
};

export type CouponLimits = { percentMin: number; percentMax: number; codeMin: number; codeMax: number };

export const DEFAULT_COUPON_LIMITS: CouponLimits = { percentMin: 1, percentMax: 90, codeMin: 4, codeMax: 16 };

export type CouponFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  onSubmit: (request: CouponRequest) => void;
  limits?: CouponLimits;
  busy?: boolean;
  error?: string | null;
  /** Reset the fields when this changes (e.g. after a coupon was created). */
  resetKey?: string | number;
};

const WHOLE = /^\d{1,10}$/;

type Fields = {
  kind: "PERCENT" | "FLAT";
  value: string;
  minSpend: string;
  startsAt: string;
  endsAt: string;
  cap: string;
  visibility: "public" | "private";
  code: string;
};
const EMPTY: Fields = {
  kind: "PERCENT",
  value: "",
  minSpend: "",
  startsAt: "",
  endsAt: "",
  cap: "",
  visibility: "private",
  code: "",
};

/** Percent (1 to 90) or flat rupees, optional minimum spend, dates and cap; public with a code or private with a generated one. */
export function CouponForm({
  onSubmit,
  limits = DEFAULT_COUPON_LIMITS,
  busy = false,
  error = null,
  resetKey,
  className,
  ...props
}: CouponFormProps) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [tried, setTried] = useState(false);
  const [lastReset, setLastReset] = useState(resetKey);
  if (lastReset !== resetKey) {
    setLastReset(resetKey);
    setF(EMPTY);
    setTried(false);
  }
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setF((x) => ({ ...x, [key]: value }));

  const errors: Partial<Record<keyof Fields, string>> = {};
  const value = WHOLE.test(f.value) ? Number(f.value) : null;
  if (value === null) errors.value = f.kind === "PERCENT" ? "Enter a whole percent." : "Enter whole rupees.";
  else if (f.kind === "PERCENT" && (value < limits.percentMin || value > limits.percentMax))
    errors.value = `Percent must be between ${limits.percentMin} and ${limits.percentMax}.`;
  else if (value < 1) errors.value = "Enter at least 1.";
  if (f.minSpend && !WHOLE.test(f.minSpend)) errors.minSpend = "Enter whole rupees, or leave empty.";
  if (f.cap && (!WHOLE.test(f.cap) || Number(f.cap) < 1))
    errors.cap = "Enter a whole number of at least 1, or leave empty.";
  const starts = f.startsAt ? new Date(f.startsAt) : null;
  const ends = f.endsAt ? new Date(f.endsAt) : null;
  if (ends && ends.getTime() <= Date.now()) errors.endsAt = "The end must be in the future.";
  else if (starts && ends && ends <= starts) errors.endsAt = "The end must be after the start.";
  const code = f.code.trim().toUpperCase();
  if (
    f.visibility === "public" &&
    (code.length < limits.codeMin || code.length > limits.codeMax || !/^[A-Z0-9]+$/.test(code))
  )
    errors.code = `Use ${limits.codeMin} to ${limits.codeMax} letters or digits.`;
  const invalid = Object.keys(errors).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (invalid || value === null) return;
    const request: CouponRequest = {
      kind: f.kind,
      value,
      isPublic: f.visibility === "public",
      ...(f.minSpend ? { minSpendRupees: Number(f.minSpend) } : {}),
      ...(starts ? { startsAt: starts.toISOString() } : {}),
      ...(ends ? { endsAt: ends.toISOString() } : {}),
      ...(f.cap ? { maxRedemptions: Number(f.cap) } : {}),
      ...(f.visibility === "public" ? { publicCode: code } : {}),
    };
    onSubmit(request);
  }
  const show = (key: keyof Fields) => (tried ? (errors[key] ?? null) : null);

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="New coupon"
      className={cn("flex flex-col gap-4 font-body", className)}
      {...props}
    >
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium text-fg">Type of discount</legend>
        <Radio
          name="coupon-kind"
          label="Percentage discount"
          checked={f.kind === "PERCENT"}
          onChange={() => set("kind", "PERCENT")}
        />
        <Radio
          name="coupon-kind"
          label="Flat rupee discount"
          checked={f.kind === "FLAT"}
          onChange={() => set("kind", "FLAT")}
        />
      </fieldset>
      <FormField
        label={f.kind === "PERCENT" ? "Percent off" : "Rupees off"}
        required
        hint={f.kind === "PERCENT" ? `${limits.percentMin} to ${limits.percentMax}.` : "Whole rupees."}
        error={show("value")}
      >
        {(c) => (
          <Input
            {...c}
            inputMode="numeric"
            autoComplete="off"
            value={f.value}
            onChange={(e) => set("value", e.target.value)}
          />
        )}
      </FormField>
      <FormField label="Minimum spend in rupees (optional)" error={show("minSpend")}>
        {(c) => (
          <Input
            {...c}
            inputMode="numeric"
            autoComplete="off"
            value={f.minSpend}
            onChange={(e) => set("minSpend", e.target.value)}
          />
        )}
      </FormField>
      <div className="grid gap-4 min-[480px]:grid-cols-2">
        <FormField label="Starts (optional)">
          {(c) => (
            <Input
              {...c}
              type="datetime-local"
              // The browser moves focus to the inner date fields, so the outer input needs its own ring.
              className="focus:outline-2 focus:outline-solid focus:outline-focus focus:outline-offset-2 focus-within:outline-2 focus-within:outline-solid focus-within:outline-focus focus-within:outline-offset-2"
              value={f.startsAt}
              onChange={(e) => set("startsAt", e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Ends (optional)" error={show("endsAt")}>
          {(c) => (
            <Input
              {...c}
              type="datetime-local"
              // The browser moves focus to the inner date fields, so the outer input needs its own ring.
              className="focus:outline-2 focus:outline-solid focus:outline-focus focus:outline-offset-2 focus-within:outline-2 focus-within:outline-solid focus-within:outline-focus focus-within:outline-offset-2"
              value={f.endsAt}
              onChange={(e) => set("endsAt", e.target.value)}
            />
          )}
        </FormField>
      </div>
      <FormField label="Most uses (optional)" hint="Leave empty for no limit." error={show("cap")}>
        {(c) => (
          <Input
            {...c}
            inputMode="numeric"
            autoComplete="off"
            value={f.cap}
            onChange={(e) => set("cap", e.target.value)}
          />
        )}
      </FormField>
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium text-fg">Who can use it</legend>
        <Radio
          name="coupon-visibility"
          label="Private: only people you give the code to. We generate the code."
          checked={f.visibility === "private"}
          onChange={() => set("visibility", "private")}
        />
        <Radio
          name="coupon-visibility"
          label="Public: shown on your shop page, with a code you choose."
          checked={f.visibility === "public"}
          onChange={() => set("visibility", "public")}
        />
      </fieldset>
      {f.visibility === "public" ? (
        <FormField
          label="Public code"
          required
          hint={`${limits.codeMin} to ${limits.codeMax} letters or digits, like SPRING10.`}
          error={show("code")}
        >
          {(c) => (
            <Input
              {...c}
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={32}
              value={f.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
            />
          )}
        </FormField>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={busy} className="self-start">
        Create coupon
      </Button>
    </form>
  );
}
