"use client";

import { Alert, Button } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { api } from "../../_lib/api";
import { markBlocked, useBlockedSellerKeys } from "../../_lib/blocks-store";
import { merchantErrorText } from "../../_lib/merchant";
import { useSession } from "../../_lib/session-store";
import { errorCode } from "../../_lib/use-api";
import { ConfirmDialog } from "../studio/ConfirmDialog";

/** What blocking does, in plain words; shown before anyone confirms. */
export const BLOCK_EXPLANATION =
  "Blocking hides this shop's products from you. It also stops purchases between you and this shop, in both directions. Only you can see that you blocked it, and you can undo it at any time.";

/** The block and unblock flow with its confirmation. `children(open)` renders the control that starts it. */
export function useBlockShop({
  companyId,
  shopName,
  returnTo,
}: {
  companyId: string;
  shopName: string;
  returnTo: string;
}) {
  const router = useRouter();
  const session = useSession();
  const blockedKeys = useBlockedSellerKeys();
  const blocked = blockedKeys.has(companyId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function start() {
    if (session.status === "signedOut") {
      router.push(`/sign-in?next=${encodeURIComponent(returnTo)}`);
      return;
    }
    setError(null);
    setOpen(true);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/blocks", { method: blocked ? "DELETE" : "POST", body: { companyId } });
      markBlocked(companyId, !blocked);
      setNotice(
        blocked
          ? `You unblocked ${shopName}. Its products are back.`
          : `You blocked ${shopName}. Its products are hidden for you.`,
      );
      setOpen(false);
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

  const dialog: ReactNode = (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title={blocked ? `Unblock ${shopName}?` : `Block ${shopName}?`}
      description={
        blocked ? "Its products will show for you again and you can buy from it." : BLOCK_EXPLANATION
      }
      confirmLabel={blocked ? "Unblock this shop" : "Block this shop"}
      danger={!blocked}
      busy={busy}
      onConfirm={() => void confirm()}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </ConfirmDialog>
  );
  const status: ReactNode = (
    <span role="status" aria-live="polite" className={notice ? "text-sm text-fg" : "sr-only"}>
      {notice ?? ""}
    </span>
  );
  return { blocked, start, dialog, status, loading: session.status === "loading" };
}

/** "Block this shop" (or "Unblock this shop") as a button, with its explanation and confirmation. */
export function BlockShopButton(props: { companyId: string; shopName: string; returnTo: string }) {
  const { blocked, start, dialog, status, loading } = useBlockShop(props);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" disabled={loading} onClick={start}>
        {blocked ? "Unblock this shop" : "Block this shop"}
      </Button>
      {status}
      {dialog}
    </div>
  );
}
