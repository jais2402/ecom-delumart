"use client";

import { BirthdateForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeError } from "../../_lib/api";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, setBirthdate } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function BirthdateScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(3);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  return (
    <BirthdateForm
      headingRef={headingRef}
      pending={pending}
      error={error}
      onSubmit={async (iso) => {
        setPending(true);
        setError(null);
        try {
          await gateway.submitBirthdate(iso);
          setBirthdate(iso);
          advanceTo(4);
          router.push("/onboarding/pin");
        } catch (err) {
          setError(describeError(err));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
