"use client";

import { type ComponentPropsWithRef, type FormEvent, useState } from "react";
import { Button } from "../../atoms/Button";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { useSettledValue } from "../../lib/useSettledValue";
import { FormField } from "../../molecules/FormField";

export type ConceptFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  initialText?: string;
  minChars: number;
  maxChars: number;
  onSubmit: (concept: string) => void;
  loading?: boolean;
  /** Plain-words reasons the server gave for this field, one sentence each. */
  reasons?: readonly string[];
  submitLabel?: string;
};

const length = (text: string) => [...text.trim()].length;

/**
 * The private invention concept. The count is shown at once; it is announced politely only after
 * typing pauses, so a screen reader is not interrupted on every key.
 */
export function ConceptForm({
  initialText = "",
  minChars,
  maxChars,
  onSubmit,
  loading = false,
  reasons = [],
  submitLabel = "Save my concept",
  className,
  ...props
}: ConceptFormProps) {
  const [text, setText] = useState(initialText);
  const [tried, setTried] = useState(false);
  const count = length(text);
  const settled = length(useSettledValue(text));
  const sizeProblem =
    count < minChars
      ? `Write at least ${minChars} characters (${minChars - count} to go).`
      : count > maxChars
        ? `Keep it to ${maxChars} characters or fewer (${count - maxChars} too many).`
        : null;
  const messages = [...(tried && sizeProblem ? [sizeProblem] : []), ...reasons];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    if (!sizeProblem) onSubmit(text.trim());
  }

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-3 font-body", className)} {...props}>
      <FormField
        label="Your invention concept"
        hint="Only you can see this. It is never published."
        error={
          messages.length > 0 ? (
            <span className="flex flex-col">
              {messages.map((message) => (
                <span key={message}>{message}</span>
              ))}
            </span>
          ) : undefined
        }
      >
        {(control) => (
          <Textarea
            {...control}
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
          />
        )}
      </FormField>
      <p aria-hidden="true" className="text-sm text-fg-muted">
        {count} of {maxChars} characters (at least {minChars})
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {settled} of {maxChars} characters
      </p>
      <Button type="submit" loading={loading} className="self-start">
        {submitLabel}
      </Button>
    </form>
  );
}
