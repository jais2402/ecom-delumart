"use client";

import { PinSetupForm } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { advanceTo, getBirthdate, messageOf } from "../../_lib/onboarding-flow";
import { useArrival } from "../../_lib/use-arrival";

export function PinScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const { ready, headingRef } = useArrival(4);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return null;

  return (
    <PinSetupForm
      headingRef={headingRef}
      birthdate={getBirthdate() ?? ""}
      pending={pending}
      error={error}
      onSubmit={async (pin) => {
        setPending(true);
        setError(null);
        try {
          await gateway.setPin(pin);
          advanceTo(5);
          router.push("/onboarding/done");
        } catch (err) {
          setError(messageOf(err));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}
