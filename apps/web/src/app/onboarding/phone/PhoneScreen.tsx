"use client";

import { PhoneForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { describeError } from "../../_lib/api";
import { advanceTo, setPhone } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function PhoneScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  return (
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
          advanceTo(2);
          router.push("/onboarding/verify");
        } catch (err) {
          setError(describeError(err));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
