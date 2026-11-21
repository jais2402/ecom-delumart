"use client";

import { type ComponentPropsWithRef, type FormEvent, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { Radio } from "../../atoms/Radio";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export type ReliefCandidate = { id: string; name: string; pricePaise?: bigint };

export type ReliefPanelProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  grantPaise: bigint;
  claimsRemaining: number;
  claimsMax: number;
  /** A few products the person has not saved before. */
  candidates: readonly ReliefCandidate[];
  onClaim: (productId: string) => void;
  loading?: boolean;
  error?: string;
  /** Set after a successful claim. `nextResetAt` is an ISO timestamp shown in the viewer's local time. */
  result?: { balancePaise: bigint; nextResetAt: string };
  headingLevel?: HeadingLevel;
};

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "the next UTC midnight";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** A calm, optional offer for a low balance: save one new product and receive the daily grant. */
export function ReliefPanel({
  grantPaise,
  claimsRemaining,
  claimsMax,
  candidates,
  onClaim,
  loading = false,
  error,
  result,
  headingLevel = 2,
  className,
  ...props
}: ReliefPanelProps) {
  const uid = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked ?? candidates[0]?.id ?? null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen) onClaim(chosen);
  }

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-info bg-info-soft p-4 font-body",
        className,
      )}
      {...props}
    >
      <Heading level={headingLevel} size="sm" id={`${uid}-title`}>
        Low balance
      </Heading>
      {result ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-base">
            Claimed. Your balance is now <Price amountPaise={result.balancePaise} display="exact" />.
          </p>
          <p className="text-sm text-fg-muted">
            You can claim again after {localTime(result.nextResetAt)}. The day resets at midnight UTC.
          </p>
        </div>
      ) : (
        <>
          <p className="text-base">
            Low balance: claim <Price amountPaise={grantPaise} className="text-base" /> of fictional money
            once a day by saving a product you have not saved before.
          </p>
          <p className="text-sm text-fg-muted">
            {claimsRemaining} of {claimsMax} claims left. The day resets at midnight UTC.
          </p>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {candidates.length > 0 ? (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <fieldset className="flex flex-col">
                <legend className="text-sm font-medium text-fg">Pick a product to save</legend>
                {candidates.map((candidate) => (
                  <Radio
                    key={candidate.id}
                    name={`${uid}-product`}
                    value={candidate.id}
                    checked={chosen === candidate.id}
                    onChange={() => setPicked(candidate.id)}
                    label={candidate.name}
                  />
                ))}
              </fieldset>
              <Button type="submit" loading={loading} className="self-start">
                Save and claim
              </Button>
            </form>
          ) : (
            <p className="text-sm text-fg-muted">
              There are no new products to suggest right now. Browse the shop and save one you like.
            </p>
          )}
        </>
      )}
      <FictionLabel>Fictional money</FictionLabel>
    </section>
  );
}
