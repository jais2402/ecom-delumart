"use client";

import { type ComponentPropsWithRef, type FormEvent, type ReactNode, useId, useState } from "react";
import { Badge } from "../../atoms/Badge";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export const MODERATION_REASON_LIMITS = { min: 5, max: 500 } as const;

export type ModerationFields = {
  name: string;
  hook: string | null;
  description: string;
  altText: string;
  category: string;
  mode: string;
  price: ReactNode;
};

export type ModerationReviewCardProps = Omit<ComponentPropsWithRef<"article">, "children" | "title"> & {
  storeName: string;
  storeHandle: string;
  /** "First submission" or "Revision", as the queue says it. */
  kindLabel: string;
  submittedAt: string;
  fields: ModerationFields;
  /** Why screening held it, in plain words. */
  reasons: readonly string[];
  /** The shopper-facing card (rendered by the page). */
  preview: ReactNode;
  onDecide: (decision: "APPROVE" | "REJECT", reason: string) => void;
  busy?: boolean;
  /** A failed decision, shown on the card. */
  error?: string | null;
};

const length = (text: string) => [...text.trim()].length;

/** One queue item: what was submitted, why it is held, a preview, and Approve or Reject with a required reason. */
export function ModerationReviewCard({
  storeName,
  storeHandle,
  kindLabel,
  submittedAt,
  fields,
  reasons,
  preview,
  onDecide,
  busy = false,
  error = null,
  className,
  ...props
}: ModerationReviewCardProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const n = length(reason);
  const problem =
    n < MODERATION_REASON_LIMITS.min
      ? `Give a reason of at least ${MODERATION_REASON_LIMITS.min} characters.`
      : n > MODERATION_REASON_LIMITS.max
        ? `Use ${MODERATION_REASON_LIMITS.max} characters or fewer.`
        : null;

  function decide(decision: "APPROVE" | "REJECT") {
    setShown(true);
    if (problem) return;
    onDecide(decision, reason.trim());
  }
  function submit(event: FormEvent) {
    event.preventDefault();
  }

  const rows: [string, ReactNode][] = [
    ["Name", fields.name],
    ["Tagline", fields.hook || "(none)"],
    ["Description", fields.description],
    ["Picture text", fields.altText || "(none)"],
    ["Category", fields.category],
    ["Stock", fields.mode],
    ["Price", fields.price],
  ];

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "grid gap-4 rounded-lg border border-border bg-surface p-4 font-body text-fg md:grid-cols-[minmax(0,1fr)_16rem]",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={3} size="sm" id={titleId} className="break-words">
            {fields.name}
          </Heading>
          <Badge tone="info">{kindLabel}</Badge>
        </div>
        <p className="text-sm text-fg-muted">
          From {storeName} (/store/{storeHandle}) · submitted {submittedAt}
        </p>
        {reasons.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-bold">Held by screening</p>
            <ul aria-label="Screening reasons" className="list-disc pl-5 text-sm">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-fg-muted">{term}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{value}</dd>
            </div>
          ))}
        </dl>
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-3"
          aria-label={`Decision on ${fields.name}`}
        >
          <FormField
            label="Reason"
            required
            hint={`${n} of ${MODERATION_REASON_LIMITS.max} characters. The seller will see this.`}
            error={shown ? problem : null}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-field="reason"
              />
            )}
          </FormField>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              aria-label={`Approve: ${fields.name}`}
              onClick={() => decide("APPROVE")}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              aria-label={`Reject: ${fields.name}`}
              onClick={() => decide("REJECT")}
            >
              Reject
            </Button>
          </div>
        </form>
      </div>
      <section className="min-w-0" aria-label="Preview as shoppers will see it">
        {preview}
      </section>
    </article>
  );
}
