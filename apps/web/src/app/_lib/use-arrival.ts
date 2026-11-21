"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FLOW_PATHS, getReached } from "./onboarding-flow";

/**
 * Sends the player back to the first missing step if they arrive too early, then moves focus
 * to the page heading once the screen is ready. `ready` is false until the check has passed.
 */
export function useArrival(required: number) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const reached = getReached();
    if (reached < required) {
      router.replace(FLOW_PATHS[reached]);
      return;
    }
    setReady(true);
  }, [required, router]);

  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  return { ready, headingRef };
}
