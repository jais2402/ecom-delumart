"use client";

import { type ComponentPropsWithRef, type FormEvent, useState } from "react";
import { Button } from "../../atoms/Button";
import { Textarea } from "../../atoms/Textarea";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export const APPEAL_LIMITS = { min: 20, max: 1000 } as const;

export type AppealFormProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  onSubmit: (statement: string) => void;
  busy?: boolean;
  error?: string | null;
};

const length = (text: string) => [...text.trim()].length;

/** One statement of 20 to 1,000 characters, with a running count. */
export function AppealForm({ onSubmit, busy = false, error = null, className, ...props }: AppealFormProps) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const n = length(text);
  const problem =
    n < APPEAL_LIMITS.min
      ? `Write at least ${APPEAL_LIMITS.min} characters (${APPEAL_LIMITS.min - n} to go).`
      : n > APPEAL_LIMITS.max
        ? `Keep it to ${APPEAL_LIMITS.max} characters or fewer (${n - APPEAL_LIMITS.max} too many).`
        : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!problem) onSubmit(text.trim());
  }

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-3 font-body", className)} {...props}>
      <FormField
        label="Why should we look again?"
        required
        hint={`${n} of ${APPEAL_LIMITS.max} characters (at least ${APPEAL_LIMITS.min}). A person reads every appeal.`}
        error={tried ? problem : null}
      >
        {(control) => (
          <Textarea {...control} rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        )}
      </FormField>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={busy} className="self-start">
        Send appeal
      </Button>
    </form>
  );
}
