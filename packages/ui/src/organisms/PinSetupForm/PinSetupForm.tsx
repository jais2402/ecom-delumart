"use client";

import { type PinWeakReason, validateNewPin } from "@delulu/core";
import { Check, Circle } from "lucide-react";
import { type ComponentPropsWithRef, type FormEvent, type Ref, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { PinField } from "../../molecules/PinField";

export type PinSetupFormProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSubmit"> & {
  onSubmit: (pin: string) => Promise<void>;
  /** Birthdate (YYYY-MM-DD) so a PIN built from it can be rejected. Never displayed. */
  birthdate: string;
  pending?: boolean;
  error?: string | null;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Title text; defaults to "Set your game PIN". */
  title?: string;
  /** Semantic level of the title: 1 on its own page, 2 when it sits inside another page. */
  headingLevel?: HeadingLevel;
  /** Label of the submit button. */
  submitLabel?: string;
};

const WEAK_TEXT: Record<PinWeakReason, string> = {
  FORMAT: "Use exactly six digits.",
  REPEATED: "Too many repeated digits. Avoid PINs like 111111 or 121212.",
  SEQUENTIAL: "That is a sequence. Avoid PINs like 123456 or 654321.",
  COMMON: "That PIN is very common. Pick one that is harder to guess.",
  BIRTHDATE: "That PIN is made from your birthdate. Pick something unrelated.",
};

function weakReason(pin: string, birthdate: string): PinWeakReason | null {
  const result = validateNewPin(pin, birthdate);
  if (result.ok) return null;
  const reason = result.error.details.reason;
  return typeof reason === "string" && reason in WEAK_TEXT ? (reason as PinWeakReason) : "FORMAT";
}

export function PinSetupForm({
  onSubmit,
  birthdate,
  pending = false,
  error,
  headingRef,
  title = "Set your game PIN",
  headingLevel = 1,
  submitLabel = "Save PIN",
  className,
  ...props
}: PinSetupFormProps) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const sixDigits = /^\d{6}$/.test(pin);
  const reason = sixDigits ? weakReason(pin, birthdate) : null;
  const strong = sixDigits && reason === null;
  const matches = confirm.length > 0 && confirm === pin;

  const pinError = reason ? WEAK_TEXT[reason] : submitted && !sixDigits ? "Enter all six digits." : undefined;
  const confirmError =
    confirm.length === 6 && confirm !== pin
      ? "The two PINs do not match."
      : submitted && !matches
        ? "Enter the same PIN again."
        : undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!strong) {
      pinRef.current?.focus();
      return;
    }
    if (!matches) {
      confirmRef.current?.focus();
      return;
    }
    void onSubmit(pin).catch(() => undefined);
  }

  const rules = [
    { label: "Six digits", met: sixDigits },
    { label: "Not repeated digits, a sequence, a common PIN or your birthdate", met: strong },
    { label: "Both PINs match", met: strong && matches },
  ];

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={headingLevel} size="md" tabIndex={-1} ref={headingRef}>
        {title}
      </Heading>
      <Alert tone="warning">Game PIN only. Do not use the PIN of a real card or UPI app.</Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <PinField
          ref={pinRef}
          label="Game PIN"
          hint="Six digits. You will use it to pay with your Delulu Card."
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          error={pinError}
          required
        />
        <PinField
          ref={confirmRef}
          label="Confirm game PIN"
          hint="Type the same six digits again."
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={confirmError}
          required
        />
        <ul aria-label="PIN rules" className="flex flex-col gap-1 font-body text-sm text-fg">
          {rules.map((rule) => (
            <li key={rule.label} className="flex items-start gap-2">
              <Icon icon={rule.met ? Check : Circle} size={16} className="mt-0.5 shrink-0" />
              <span>
                <VisuallyHidden>{rule.met ? "Met: " : "Not met yet: "}</VisuallyHidden>
                {rule.label}
              </span>
            </li>
          ))}
        </ul>
        <Button type="submit" variant="cta" size="lg" loading={pending}>
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
