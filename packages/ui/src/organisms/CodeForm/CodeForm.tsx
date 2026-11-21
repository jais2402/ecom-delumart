"use client";

import {
  type ComponentPropsWithRef,
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Input } from "../../atoms/Input";
import { Label } from "../../atoms/Label";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export const DEFAULT_RESEND_SECONDS = 30;
const CODE_LENGTH = 6;

export type CodeFormProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSubmit"> & {
  onSubmit: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  pending?: boolean;
  error?: string | null;
  /** Seconds before the resend button works again. */
  resendSeconds?: number;
  /** Optional notice above the form, e.g. a demo-mode note. */
  notice?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
};

export function CodeForm({
  onSubmit,
  onResend,
  pending = false,
  error,
  resendSeconds = DEFAULT_RESEND_SECONDS,
  notice,
  headingRef,
  className,
  ...props
}: CodeFormProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const timerId = `${id}-timer`;
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(resendSeconds);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.length !== CODE_LENGTH) {
      setFieldError(`Enter the ${CODE_LENGTH}-digit code from your text message.`);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    void onSubmit(code).catch(() => undefined);
  }

  async function resend() {
    try {
      await onResend();
      setRemaining(resendSeconds);
    } catch {
      // The page shows the server error.
    }
  }

  // Announce politely only every 10 seconds and at zero, so a screen reader is not flooded.
  const announce =
    remaining === 0
      ? "You can request a new code now."
      : remaining % 10 === 0
        ? `You can request a new code in ${remaining} seconds.`
        : null;

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        Enter your code
      </Heading>
      {notice}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id} required>
            6-digit verification code
          </Label>
          <Input
            id={id}
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={CODE_LENGTH}
            invalid={Boolean(fieldError)}
            aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
              if (fieldError) setFieldError(null);
            }}
            className="font-mono tracking-widest"
          />
          <p id={hintId} className="font-body text-sm text-fg-muted">
            We sent it by text to confirm your DeluluMart account.
          </p>
          {fieldError ? (
            <p id={errorId} className="font-body text-sm font-medium text-danger">
              {fieldError}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" loading={pending}>
          Verify code
        </Button>
      </form>
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="secondary"
          disabled={remaining > 0 || pending}
          aria-describedby={timerId}
          onClick={resend}
        >
          Resend code
        </Button>
        <p id={timerId} className="font-body text-sm text-fg-muted">
          {remaining > 0 ? `You can ask for a new code in ${remaining}s.` : "You can ask for a new code now."}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
    </div>
  );
}
