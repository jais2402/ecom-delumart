"use client";

import { Alert, CodeForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeError } from "../../_lib/api";
import { devCode } from "../../_lib/api-gateway";
import { useDevProvider } from "../../_lib/dev-mode";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, getPhone } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function VerifyScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(2);
  const dev = useDevProvider();
  const code = devCode();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  async function guarded(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
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
        dev && code ? (
          <Alert tone="info" title="Local development">
            No text message is sent. The code for this sign-in is {code}.
          </Alert>
        ) : undefined
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
