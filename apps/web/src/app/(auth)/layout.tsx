import type { ReactNode } from "react";
import { OnboardingShell } from "../_lib/OnboardingShell";

/** Private: rendered per request and sent `Cache-Control: private, no-store` (src/proxy.ts). */
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <OnboardingShell>{children}</OnboardingShell>;
}
