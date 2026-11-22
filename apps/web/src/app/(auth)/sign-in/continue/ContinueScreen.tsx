"use client";

import { Heading, Text } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { resetCsrf } from "../../../_lib/api";
import { useGateway } from "../../../_lib/gateway-context";
import { safeReturnPath } from "../../../_lib/onboarding-flow";
import { refreshSession } from "../../../_lib/session-store";

/**
 * After the sign-in callback: the session cookie is set, so the CSRF token and the session are
 * reloaded, then the browser goes to the first unfinished onboarding step, or to the return path
 * the server already checked (checked again here: it is read from the URL).
 */
export function ContinueScreen() {
  const gateway = useGateway();
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      resetCsrf();
      await refreshSession();
      const next = safeReturnPath(
        new URLSearchParams(window.location.search).get("next"),
        window.location.origin,
      );
      const path = await gateway.resolveStep().catch(() => "/sign-in");
      router.replace(path === "/account" ? next : path);
    })();
  }, [gateway, router]);

  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="md">
        Signing you in
      </Heading>
      <Text muted role="status">
        One moment…
      </Text>
    </div>
  );
}
