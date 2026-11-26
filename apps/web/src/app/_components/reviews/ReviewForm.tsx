"use client";

import { REVIEW_RULES } from "@delulu/core";
import { Alert, Button, FormField, Input, StarRatingInput, Textarea } from "@delulu/ui";
import { type FormEvent, useState } from "react";
import { ApiError, api, describeError } from "../../_lib/api";
import {
  type OwnReviewView,
  type ReviewField,
  reviewFieldErrors,
  type SaveReviewResponse,
} from "../../_lib/reviews";

/**
 * Write or edit the signed-in owner's review: a star radio group, an optional title and an optional
 * review. Field refusals from the server (REVIEW_INVALID) are shown inline under each field.
 */
export function ReviewForm({
  productId,
  existing,
  handle,
  onSaved,
  onCancel,
}: {
  productId: string;
  existing: OwnReviewView | null;
  handle: string | null;
  onSaved: (review: OwnReviewView) => void;
  onCancel: () => void;
}) {
  const [rating, setRating] = useState<number | null>(existing?.rating ?? null);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [errors, setErrors] = useState<Partial<Record<ReviewField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rating === null) {
      setErrors({ rating: "Choose a star rating." });
      return;
    }
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const saved = await api<SaveReviewResponse>(`/api/v1/products/${productId}/review`, {
        method: "PUT",
        body: { rating, title: title.trim() === "" ? null : title, body: body.trim() === "" ? null : body },
      });
      onSaved(saved.review);
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVIEW_INVALID") {
        const fields = reviewFieldErrors(e.details);
        setErrors(fields);
        if (Object.keys(fields).length === 0) setError(describeError(e));
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label={existing ? "Edit your review" : "Write a review"}
      onSubmit={(e) => void submit(e)}
      noValidate
      className="flex flex-col gap-4"
    >
      <StarRatingInput
        legend="Your rating"
        value={rating}
        onChange={setRating}
        error={errors.rating ?? null}
        required
        disabled={busy}
      />
      <FormField
        label="Title (optional)"
        error={errors.title}
        hint={`Up to ${REVIEW_RULES.titleMaxChars} characters.`}
      >
        {(control) => (
          <Input
            {...control}
            value={title}
            maxLength={REVIEW_RULES.titleMaxChars}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
          />
        )}
      </FormField>
      <FormField
        label="Your review (optional)"
        error={errors.body}
        hint={`Up to ${REVIEW_RULES.bodyMaxChars.toLocaleString("en-IN")} characters. No links, contact details or card numbers.`}
      >
        {(control) => (
          <Textarea
            {...control}
            value={body}
            maxLength={REVIEW_RULES.bodyMaxChars}
            rows={5}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
          />
        )}
      </FormField>
      <p className="font-body text-sm text-fg-muted">
        Shown as {handle ? `@${handle}` : "a verified owner"}, with the day you post it.
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          {existing ? "Save changes" : "Post review"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
