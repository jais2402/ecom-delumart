"use client";

import { Alert, CodeForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Challenge } from "../../_components/Challenge";
import { ApiError, describeError } from "../../_lib/api";
import { devCode } from "../../_lib/api-gateway";
import { useDevProvider } from "../../_lib/dev-mode";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, getPhone } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function VerifyScreen({ challengeSiteKey = null }: { challengeSiteKey?: string | null }) {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(2);
  const dev = useDevProvider();
  const code = devCode();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a new code (resend) needs a fresh security-check token, like the first one
  const [challenge, setChallenge] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

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
    <div className="flex flex-col gap-4">
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
        onResend={() =>
          guarded(async () => {
            if (challengeSiteKey !== null && challenge === null) {
              throw new ApiError("CAPTCHA_FAILED", "Complete the security check below first.", false, 0);
            }
            const token = challenge;
            setChallenge(null);
            setGeneration((g) => g + 1);
            await gateway.submitPhone(getPhone() ?? "", token);
          })
        }
      />
      <Challenge
        siteKey={challengeSiteKey}
        action="phone_code"
        onToken={setChallenge}
        generation={generation}
      />
    </div>
  );
}
