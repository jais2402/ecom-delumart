"use client";

import { Button } from "@delulu/ui";
import { RecoveryScreen } from "./_components/recovery/RecoveryScreen";

/**
 * A page that failed while rendering. The message of the error is never shown (it can name internals);
 * only the short reference Next.js gives, so a report can be matched to the server log.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RecoveryScreen
      title="Something went wrong"
      message="That page did not load. Nothing was lost and no fictional money moved. Try again, or carry on shopping."
      {...(error.digest ? { detail: `Reference: ${error.digest}` } : {})}
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
