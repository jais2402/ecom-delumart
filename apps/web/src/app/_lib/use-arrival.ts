"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useGateway } from "./gateway-context";
import { FLOW_PATHS } from "./onboarding-flow";

function rank(path: string): number {
  const index = (FLOW_PATHS as readonly string[]).indexOf(path);
  return index === -1 ? FLOW_PATHS.length : index; // "/account" ranks after every step
}

/**
 * Asks the server where this person is in onboarding and sends them to the first incomplete step
 * if they arrive too early (or to /account if they are already done), then moves focus to the page
 * heading once the screen is ready. `ready` is false until the check has passed.
 * `required` is the step index of this page in FLOW_PATHS.
 */
export function useArrival(required: number) {
  const router = useRouter();
  const gateway = useGateway();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void gateway
      .resolveStep()
      .then((path) => {
        if (cancelled) return;
        const reached = rank(path);
        const finished = reached === FLOW_PATHS.length;
        const isDonePage = required === FLOW_PATHS.length - 1;
        if (finished) {
          if (!isDonePage) router.replace("/account");
          else setReady(true);
        } else if (reached < required || (required === 0 && reached > 0)) {
          router.replace(path);
        } else {
          setReady(true);
        }
      })
      .catch(() => {
        // the screen's own call will show the server's message
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [required, router, gateway]);

  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  return { ready, headingRef };
}
