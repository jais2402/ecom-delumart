"use client";

import { ShieldCheck } from "lucide-react";
import { type ComponentPropsWithRef, type FormEvent, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Input } from "../../atoms/Input";
import { Label } from "../../atoms/Label";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";
import { PinField } from "../../molecules/PinField";

export type BankChallengeProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  amountPaise: bigint;
  /** Friendly name of the virtual card, e.g. "Everyday card". Never a number. */
  cardAlias: string;
  merchantName?: string;
  /** Ask for the six-digit game PIN or a six-digit SecureCheck code. */
  method?: "pin" | "code";
  onPay: (secret: string) => void;
  onCancel: () => void;
  error?: string;
  loading?: boolean;
  /** Semantic level of the title; 1 on a standalone bank page. */
  headingLevel?: HeadingLevel;
};

/** Mock bank step. There is deliberately no field for a card number, expiry or CVV. */
export function BankChallenge({
  amountPaise,
  cardAlias,
  merchantName = "DeluluMart",
  method = "pin",
  onPay,
  onCancel,
  error,
  loading,
  headingLevel = 1,
  className,
  ...props
}: BankChallengeProps) {
  const [secret, setSecret] = useState("");
  const codeId = useId();
  const titleId = useId();
  const ready = /^\d{6}$/.test(secret);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready) onPay(secret);
  }

  return (
    <form
      aria-labelledby={titleId}
      onSubmit={submit}
      className={cn("flex flex-col gap-4 rounded-lg bg-surface p-4 font-body md:p-6", className)}
      {...props}
    >
      <div className="flex items-center gap-2 text-action">
        <Icon icon={ShieldCheck} size={24} />
        <Heading level={headingLevel} size="md" id={titleId} className="text-fg">
          Delulu Bank SecureCheck
        </Heading>
      </div>
      <dl className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 text-base">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">Pay {merchantName}</dt>
          <dd>
            <Price amountPaise={amountPaise} display="exact" className="text-lg" />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-muted">Card</dt>
          <dd className="font-medium text-fg">{cardAlias}</dd>
        </div>
      </dl>
      {method === "pin" ? (
        <PinField
          label="Delulu PIN (game only)"
          error={error}
          onChange={(event) => setSecret(event.target.value)}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <Label htmlFor={codeId}>SecureCheck code (six digits, game only)</Label>
          <Input
            id={codeId}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            pattern="[0-9]{6}"
            invalid={Boolean(error)}
            className="font-mono tracking-widest"
            value={secret}
            onChange={(event) => setSecret(event.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
        </div>
      )}
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
        <span>In-game payment · fictional money</span>
        <FictionLabel>No real card details</FictionLabel>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="ctaStrong"
          disabled={!ready}
          loading={Boolean(loading)}
          className="flex-1"
        >
          Pay
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
      </div>
    </form>
  );
}
