"use client";

import { SaveButton } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toggleSaved, useSaves } from "../_lib/saves-store";
import { nextOnboardingPath, useSession } from "../_lib/session-store";

/**
 * The save heart for one product. Signed-out visitors are sent to sign in and come back to this
 * page; the result is announced politely, and a refusal puts the heart back with a short message.
 */
export function SaveToggle({
  productId,
  name,
  className,
  round = false,
}: {
  productId: string;
  name: string;
  className?: string;
  /** A round button with a faint shadow, for sitting on a picture's corner. */
  round?: boolean;
}) {
  const router = useRouter();
  const session = useSession();
  const signedIn = session.status === "signedIn";
  const saves = useSaves(signedIn);
  const [announce, setAnnounce] = useState("");
  const [busy, setBusy] = useState(false);
  const saved = saves.ids.has(productId.toLowerCase());

  async function onToggle() {
    if (session.status !== "signedIn") {
      const here = `${window.location.pathname}${window.location.search}`;
      router.push(`/sign-in?next=${encodeURIComponent(here)}`);
      return;
    }
    const next = nextOnboardingPath(session.onboarding, false);
    if (next !== "/account") {
      router.push(next);
      return;
    }
    if (busy) return;
    setBusy(true);
    const result = await toggleSaved(productId);
    setBusy(false);
    if (result.ok) setAnnounce(result.saved ? `${name} saved.` : `${name} removed from saved.`);
    else setAnnounce(`Could not update saved: ${result.message}`);
  }

  return (
    <div className={className}>
      <SaveButton
        productName={name}
        saved={saved}
        {...(round ? { className: "rounded-pill shadow-raised" } : {})}
        disabled={
          session.status === "loading" ||
          (signedIn && (saves.status === "idle" || saves.status === "loading"))
        }
        onToggle={() => void onToggle()}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
