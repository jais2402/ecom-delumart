"use client";

import { Alert, CodeForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, getPhone, messageOf } from "../../_lib/onboarding-flow";
import { DEMO_PHONE_CODE } from "../../_lib/onboarding-gateway";
import { useArrival } from "../../_lib/use-arrival";

export function VerifyScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(2);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  async function guarded(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageOf(err));
      throw err;
    } finally {
      setPending(false);
    }
  }

  return (
    <CodeForm
      headingRef={headingRef}
      pending={pending}
      error={error}
      notice={
        <Alert tone="info" title="Demo notice">
          No text message is sent. The demo code is {DEMO_PHONE_CODE}.
        </Alert>
      }
      onSubmit={(code) =>
        guarded(async () => {
          await gateway.verifyPhoneCode(code);
          advanceTo(3);
          router.push("/onboarding/birthdate");
        })
      }
      onResend={() => guarded(() => gateway.submitPhone(getPhone() ?? ""))}
    />
  );
}
