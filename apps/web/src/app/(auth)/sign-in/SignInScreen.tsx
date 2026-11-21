"use client";

import { SignInPanel } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { getReturnTo, messageOf, safeReturnPath, setReturnTo } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";
import { describeError } from "../../_lib/api";

export function SignInScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  async function emailSignIn(email: string) {
    setPending(true);
    setError(null);
    try {
      // where to come back to, e.g. the product the person wanted to buy
      const next = safeReturnPath(new URLSearchParams(window.location.search).get("next"));
      if (next) setReturnTo(next);
      await gateway.requestEmailLink(email);
      const path = await gateway.resolveStep();
      router.push(path === "/account" ? (getReturnTo() ?? "/account") : path);
    } catch (err) {
      setError(describeError(err) || messageOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <SignInPanel
      headingRef={headingRef}
      pending={pending}
      error={error}
      onGoogle={async () => {
        setError(null);
        try {
          await gateway.startGoogleSignIn();
        } catch (err) {
          setError(messageOf(err));
        }
      }}
      onEmailSubmit={emailSignIn}
    />
  );
}
