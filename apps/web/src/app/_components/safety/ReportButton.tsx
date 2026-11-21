"use client";

import { Button, ReportDialog, type ReportReasonValue } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../_lib/api";
import { merchantErrorText } from "../../_lib/merchant";
import { useSession } from "../../_lib/session-store";
import { errorCode } from "../../_lib/use-api";

/**
 * "Report" for a product or a store. Signed-out visitors are sent to sign in and come back. The
 * dialog confirms with the case reference; it never says who is reported to whom.
 */
export function ReportButton({
  targetType,
  targetId,
  targetName,
  returnTo,
  label = "Report",
}: {
  targetType: "PRODUCT" | "STORE";
  targetId: string;
  targetName: string;
  returnTo: string;
  label?: string;
}) {
  const router = useRouter();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  function openDialog() {
    if (session.status === "signedOut") {
      router.push(`/sign-in?next=${encodeURIComponent(returnTo)}`);
      return;
    }
    setError(null);
    setReference(null);
    setOpen(true);
  }

  async function send(reason: ReportReasonValue, detail: string) {
    setBusy(true);
    setError(null);
    try {
      const receipt = await api<{ reference: string }>("/api/v1/reports", {
        method: "POST",
        body: { targetType, targetId, reason, ...(detail ? { detail } : {}) },
      });
      setReference(receipt.reference);
    } catch (e) {
      if (errorCode(e) === "AUTH_REQUIRED") {
        router.push(`/sign-in?next=${encodeURIComponent(returnTo)}`);
        return;
      }
      setError(merchantErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" disabled={session.status === "loading"} onClick={openDialog}>
        {label}
      </Button>
      <ReportDialog
        open={open}
        onOpenChange={setOpen}
        targetName={targetName}
        busy={busy}
        error={error}
        reference={reference}
        onSubmit={(r, d) => void send(r, d)}
      />
    </>
  );
}
