"use client";

import { Alert, PhoneForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Challenge } from "../../_components/Challenge";
import { describeError } from "../../_lib/api";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, setPhone } from "../../_lib/onboarding-flow";
import { useSession } from "../../_lib/session-store";
import { useArrival } from "../../_lib/use-arrival";

export function PhoneScreen({ challengeSiteKey = null }: { challengeSiteKey?: string | null }) {
  const gateway = useGateway();
  const router = useRouter();
  const session = useSession();
  const { ready, headingRef } = useArrival(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const signedIn = session.status === "signedIn";
  // 'unverified' (an owner setting): no text message is sent, the number is recorded as given
  const noCode = signedIn && session.phoneVerification === "unverified";
  // the account's earlier unverified number now belongs to someone who confirmed it by text
  const askedAgain = signedIn && session.onboarding?.phoneReverifyRequired === true;
  const siteKey = challengeSiteKey;

  if (!ready) return null;

  return (
    <div className="flex flex-col gap-4">
      {askedAgain ? (
        <Alert tone="info" title="We need your phone number again">
          The number on this account was confirmed by its owner on another account, so it was removed from
          yours. Nothing else about your account has changed. Enter your own number to continue.
        </Alert>
      ) : null}
      <PhoneForm
        headingRef={headingRef}
        pending={pending}
        error={error}
        onSubmit={async (e164) => {
          if (siteKey !== null && challenge === null) {
            setError("Complete the security check below first.");
            return;
          }
          setPending(true);
          setError(null);
          const token = challenge;
          setChallenge(null);
          setGeneration((g) => g + 1);
          try {
            await gateway.submitPhone(e164, token);
            setPhone(e164);
            if (noCode) {
              advanceTo(3);
              router.push("/onboarding/birthdate");
            } else {
              advanceTo(2);
              router.push("/onboarding/verify");
            }
          } catch (err) {
            setError(describeError(err));
          } finally {
            setPending(false);
          }
        }}
      />
      <Challenge siteKey={siteKey} action="phone_code" onToken={setChallenge} generation={generation} />
      {noCode ? (
        <Alert tone="info" title="No text message for now">
          We are not checking numbers by text message yet, so we will not send you a code and your number
          stays marked as not verified. We keep it only as a scrambled fingerprint, to allow one account per
          phone number. Use your own number: if its owner later confirms it by text message, it moves to their
          account and we ask you for a number again.
        </Alert>
      ) : null}
    </div>
  );
}
