"use client";

import { Alert, OnboardingLayout, OnboardingProgress } from "@delulu/ui";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { GatewayProvider } from "./gateway-context";

const STEP_BY_PATH: Record<string, number> = {
  "/sign-in": 0,
  "/onboarding/phone": 1,
  "/onboarding/verify": 1,
  "/onboarding/birthdate": 2,
  "/onboarding/pin": 3,
  "/onboarding/done": 4,
};

/** Shared frame for sign-in and onboarding: gateway provider, demo banner and progress. */
export function OnboardingShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = STEP_BY_PATH[pathname.replace(/\/$/, "")] ?? 0;
  return (
    <GatewayProvider>
      <OnboardingLayout
        banner={
          <Alert tone="warning">Demo mode: sign-in is not connected yet. Nothing you enter is saved.</Alert>
        }
        progress={<OnboardingProgress current={current} />}
      >
        {children}
      </OnboardingLayout>
    </GatewayProvider>
  );
}
