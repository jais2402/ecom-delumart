"use client";

import { normalizePhone } from "@delulu/core";
import { type ComponentPropsWithRef, type FormEvent, type Ref, useId, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Input } from "../../atoms/Input";
import { Label } from "../../atoms/Label";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export type PhoneFormProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSubmit"> & {
  /** Receives the number in E.164 form, e.g. +919876543210. */
  onSubmit: (e164: string) => Promise<void>;
  pending?: boolean;
  error?: string | null;
  headingRef?: Ref<HTMLHeadingElement>;
};

const INVALID = "Enter a valid 10-digit Indian mobile number. It starts with 6, 7, 8 or 9.";

/** India (+91) only for now: the prefix is fixed and not editable. */
export function PhoneForm({
  onSubmit,
  pending = false,
  error,
  headingRef,
  className,
  ...props
}: PhoneFormProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [national, setNational] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let e164: string;
    try {
      e164 = normalizePhone(`+91${national}`);
    } catch {
      setFieldError(INVALID);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    void onSubmit(e164).catch(() => undefined);
  }

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        Add your phone number
      </Heading>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id} required>
            Mobile number (India)
          </Label>
          <div className="flex items-stretch gap-2">
            <span
              data-testid="country-code"
              className="inline-flex min-h-touch items-center rounded-md border border-border bg-action-soft px-3 font-mono text-base text-fg"
            >
              <span aria-hidden="true">+91</span>
              <span className="sr-only">Country code plus 91, fixed</span>
            </span>
            <Input
              id={id}
              ref={inputRef}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              required
              maxLength={16}
              invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
              value={national}
              onChange={(event) => {
                setNational(event.target.value);
                if (fieldError) setFieldError(null);
              }}
              className="min-w-0 flex-1"
            />
          </div>
          <p id={hintId} className="font-body text-sm text-fg-muted">
            Used only to keep one account per person. No marketing messages.
          </p>
          {fieldError ? (
            <p id={errorId} className="font-body text-sm font-medium text-danger">
              {fieldError}
            </p>
          ) : null}
        </div>
        <Button type="submit" variant="cta" size="lg" loading={pending}>
          Send verification code
        </Button>
      </form>
    </div>
  );
}
