"use client";

import { Alert, PhoneForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeError } from "../../_lib/api";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, setPhone } from "../../_lib/onboarding-flow";
import { useSession } from "../../_lib/session-store";
import { useArrival } from "../../_lib/use-arrival";

export function PhoneScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const session = useSession();
  const { ready, headingRef } = useArrival(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'unverified' (an owner setting): no text message is sent, the number is recorded as given
  const noCode = session.status === "signedIn" && session.phoneVerification === "unverified";

  if (!ready) return null;

  return (
    <div className="flex flex-col gap-4">
      <PhoneForm
        headingRef={headingRef}
        pending={pending}
        error={error}
        onSubmit={async (e164) => {
          setPending(true);
          setError(null);
          try {
            await gateway.submitPhone(e164);
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
      {noCode ? (
        <Alert tone="info" title="No text message for now">
          We are not checking numbers by text message yet, so we will not send you a code. We keep your number
          only as a scrambled fingerprint, to allow one account per phone number. Use your own number: it
          cannot be used for another account later.
        </Alert>
      ) : null}
    </div>
  );
}
