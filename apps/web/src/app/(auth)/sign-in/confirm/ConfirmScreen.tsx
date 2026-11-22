"use client";

import { Alert, Button, Heading, Text } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { describeError } from "../../../_lib/api";
import { safeReturnPath } from "../../../_lib/onboarding-flow";
import { confirmEmailLink } from "../../../_lib/supabase-sign-in";

/**
 * The emailed link's landing page: one button. Nothing is redeemed until it is pressed; then the
 * server checks the link for THIS browser's sign-in (it must be the browser that asked for the
 * email) and sets the session. The link's secret is taken out of the address bar at once, so it
 * does not stay in the history.
 */
export function ConfirmScreen({
  link,
}: {
  link: { tokenHash: string; type: string } | { code: string } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(
    link === null ? "This sign-in link is not complete. Ask for a new one on the sign-in page." : null,
  );

  useEffect(() => {
    if (window.location.search !== "") window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function confirm() {
    if (link === null) return;
    setPending(true);
    setError(null);
    try {
      const next = await confirmEmailLink(link);
      router.replace(
        `/sign-in/continue?next=${encodeURIComponent(safeReturnPath(next, window.location.origin))}`,
      );
    } catch (err) {
      setError(describeError(err));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="md">
        Finish signing in
      </Heading>
      <Text muted>
        Press the button to sign in to DeluluMart in this browser. Use the same browser you asked for the
        email in.
      </Text>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {link === null || error ? (
        <a className="text-action underline underline-offset-2" href="/sign-in">
          Back to sign in
        </a>
      ) : null}
      {link !== null ? (
        <Button type="button" loading={pending} onClick={() => void confirm()}>
          Sign in
        </Button>
      ) : null}
    </div>
  );
}
