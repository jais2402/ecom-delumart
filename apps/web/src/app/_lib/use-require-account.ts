"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { nextOnboardingPath, type SessionState, useSession } from "./session-store";

/**
 * Guard for private pages: signed-out visitors go to /sign-in (and come back after), people who
 * have not finished onboarding go to their next step. `ok` is true only for a finished account.
 */
export function useRequireAccount(): { session: SessionState; ok: boolean } {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.status === "signedOut") {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
    } else if (session.status === "signedIn") {
      const next = nextOnboardingPath(session.onboarding, false);
      if (next !== "/account") router.replace(next);
    }
  }, [session, router, pathname]);

  const ok = session.status === "signedIn" && nextOnboardingPath(session.onboarding, false) === "/account";
  return { session, ok };
}
