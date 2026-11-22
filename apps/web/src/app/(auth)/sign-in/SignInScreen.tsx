"use client";

import { Alert, Button, FormField, Input, SignInPanel } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Challenge } from "../../_components/Challenge";
import { describeError } from "../../_lib/api";
import { useDevProvider } from "../../_lib/dev-mode";
import { useGateway } from "../../_lib/gateway-context";
import {
  DEFAULT_RETURN_PATH,
  getReturnTo,
  messageOf,
  safeReturnPath,
  setReturnTo,
} from "../../_lib/onboarding-flow";
import {
  callbackErrorMessage,
  startEmailSignIn,
  startGoogleSignIn,
  verifyEmailCode,
} from "../../_lib/supabase-sign-in";
import { useArrival } from "../../_lib/use-arrival";

const CODE = /^\d{6,10}$/;

const CHECK_FIRST = "Complete the security check below first.";

export function SignInScreen({
  devProvider = false,
  callbackError = null,
  challengeSiteKey = null,
}: {
  devProvider?: boolean;
  /** The ?error= the sign-in callback sent the browser back with. */
  callbackError?: string | null;
  /** Cloudflare Turnstile's public site key, or null when this deployment asks for no check. */
  challengeSiteKey?: string | null;
}) {
  const devSeen = useDevProvider();
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(callbackErrorMessage(callbackError));
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const dev = devProvider || devSeen;
  const siteKey = dev ? null : challengeSiteKey;
  /** The current token, spent: the widget resets for the next request. */
  const spendChallenge = (): string | null => {
    const token = challenge;
    setChallenge(null);
    setGeneration((g) => g + 1);
    return token;
  };

  if (!ready) return null;

  async function goOn(returnPath: string) {
    const path = await gateway.resolveStep();
    router.push(path === "/account" ? safeReturnPath(returnPath, window.location.origin) : path);
  }

  async function emailSignIn(email: string) {
    setPending(true);
    setError(null);
    try {
      if (!dev) {
        if (siteKey !== null && challenge === null) {
          setError(CHECK_FIRST);
          return;
        }
        await startEmailSignIn(email, spendChallenge());
        setSentTo(email);
        return;
      }
      // where to come back to, e.g. the product the person wanted to buy
      const next = new URLSearchParams(window.location.search).get("next");
      if (next !== null) setReturnTo(next, window.location.origin);
      await gateway.requestEmailLink(email);
      await goOn(getReturnTo() ?? DEFAULT_RETURN_PATH);
    } catch (err) {
      setError(describeError(err) || messageOf(err));
    } finally {
      setPending(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sentTo === null) return;
    if (!CODE.test(code)) {
      setCodeError("Enter the code from the email: 6 or more digits.");
      return;
    }
    if (siteKey !== null && challenge === null) {
      setCodeError(CHECK_FIRST);
      return;
    }
    setCodeError(null);
    setPending(true);
    try {
      const next = await verifyEmailCode(sentTo, code, spendChallenge());
      await goOn(next);
    } catch (err) {
      setCodeError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SignInPanel
        headingRef={headingRef}
        pending={pending}
        devMode={dev}
        error={error}
        sentTo={sentTo}
        onUseDifferentEmail={() => {
          setSentTo(null);
          setCode("");
          setCodeError(null);
        }}
        afterSent={
          sentTo === null ? null : (
            <form noValidate onSubmit={submitCode} className="flex flex-col gap-4">
              <Alert tone="info">
                The link works only in this browser. You can also type the code from the email.
              </Alert>
              <FormField label="Code from the email" hint="Only digits." error={codeError}>
                {(control) => (
                  <Input
                    {...control}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={10}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    className="font-mono tracking-widest"
                  />
                )}
              </FormField>
              <Button type="submit" loading={pending}>
                Sign in with the code
              </Button>
            </form>
          )
        }
        onGoogle={async () => {
          setError(null);
          try {
            if (dev) await gateway.startGoogleSignIn();
            else await startGoogleSignIn();
          } catch (err) {
            setError(describeError(err) || messageOf(err));
          }
        }}
        onEmailSubmit={emailSignIn}
      />
      <Challenge
        siteKey={siteKey}
        action={sentTo === null ? "email_start" : "email_verify"}
        onToken={setChallenge}
        generation={generation}
      />
    </div>
  );
}
