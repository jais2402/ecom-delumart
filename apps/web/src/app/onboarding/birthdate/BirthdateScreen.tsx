"use client";

import { BirthdateForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, messageOf, setBirthdate } from "../../_lib/onboarding-flow";
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
          setError(messageOf(err));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
