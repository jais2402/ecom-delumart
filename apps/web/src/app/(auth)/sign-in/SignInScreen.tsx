"use client";

import { Alert, Button, SignInPanel } from "@delulu/ui";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, messageOf } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function SignInScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Move focus to the heading again when the confirmation replaces the form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sentTo is the trigger
  useEffect(() => {
    if (sentTo) headingRef.current?.focus();
  }, [sentTo, headingRef]);

  if (!ready) return null;

  async function run(action: () => Promise<void>, onDone: () => void) {
    setPending(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInPanel
      headingRef={headingRef}
      pending={pending}
      error={error}
      sentTo={sentTo}
      onUseDifferentEmail={() => setSentTo(null)}
      onGoogle={() =>
        run(
          () => gateway.startGoogleSignIn(),
          () => {
            advanceTo(1);
            router.push("/onboarding/phone");
          },
        )
      }
      onEmailSubmit={(email) =>
        run(
          () => gateway.requestEmailLink(email),
          () => setSentTo(email),
        )
      }
      afterSent={
        <>
          <Alert tone="info" title="Demo notice">
            No email was really sent. Use the button below to pretend you opened the link.
          </Alert>
          <Button asChild size="lg">
            <NextLink href="/onboarding/phone" onClick={() => advanceTo(1)}>
              Continue to the phone step (demo)
            </NextLink>
          </Button>
        </>
      }
    />
  );
}
