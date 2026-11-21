"use client";

import { normalizeEmail } from "@delulu/core";
import {
  type ComponentPropsWithRef,
  type FormEvent,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Input } from "../../atoms/Input";
import { Text } from "../../atoms/Text";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";
import { FormField } from "../../molecules/FormField";

export type SignInPanelProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSubmit"> & {
  onGoogle: () => Promise<void>;
  onEmailSubmit: (email: string) => Promise<void>;
  /** True while a request is in flight. */
  pending?: boolean;
  /** Message from the server, shown in an alert. */
  error?: string | null;
  /** When set, the "check your inbox" confirmation is shown for this address. */
  sentTo?: string | null;
  onUseDifferentEmail?: () => void;
  /** Extra content under the confirmation message. */
  afterSent?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  /** True when sign-in is the local development provider: no email is sent, so the copy says so. */
  devMode?: boolean;
};

export function SignInPanel({
  onGoogle,
  onEmailSubmit,
  pending = false,
  error,
  sentTo,
  onUseDifferentEmail,
  afterSent,
  headingRef,
  devMode = false,
  className,
  ...props
}: SignInPanelProps) {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let clean: string;
    try {
      clean = normalizeEmail(email);
    } catch {
      setFieldError("Enter a valid email address, like name@example.com.");
      emailRef.current?.focus();
      return;
    }
    setFieldError(null);
    // Send the address as typed (trimmed); the server normalises for uniqueness.
    void onEmailSubmit(email.trim() || clean).catch(() => undefined);
  }

  if (sentTo) {
    return (
      <div className={cn("flex flex-col gap-4", className)} {...props}>
        <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
          Check your inbox
        </Heading>
        <Alert tone="success" title="Sign-in link sent">
          We sent a sign-in link to <span className="break-all font-medium">{sentTo}</span>. Open it on this
          device to continue.
        </Alert>
        {afterSent}
        {onUseDifferentEmail ? (
          <Button variant="secondary" onClick={onUseDifferentEmail}>
            Use a different email
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        Sign in or create your account
      </Heading>
      <Text muted>One account per person. You start with fictional money.</Text>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        variant="secondary"
        size="lg"
        disabled={pending}
        onClick={() => void onGoogle().catch(() => undefined)}
      >
        Continue with Google
      </Button>
      <p className="text-center font-body text-sm text-fg-muted">
        {devMode ? "or sign in with any email address" : "or use an email link"}
      </p>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <FormField
          label="Email address"
          required
          hint={
            devMode
              ? "Local development sign-in: no email is sent."
              : "We email you a one-time sign-in link. No password."
          }
          error={fieldError}
        >
          {(control) => (
            <Input
              {...control}
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (fieldError) setFieldError(null);
              }}
            />
          )}
        </FormField>
        <Button type="submit" size="lg" loading={pending}>
          {devMode ? "Sign in locally" : "Email me a sign-in link"}
        </Button>
      </form>
    </div>
  );
}
