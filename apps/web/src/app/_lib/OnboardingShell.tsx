"use client";

import { Alert, OnboardingLayout, OnboardingProgress } from "@delulu/ui";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useDevProvider } from "./dev-mode";
import { GatewayProvider } from "./gateway-context";

const STEP_BY_PATH: Record<string, number> = {
  "/sign-in": 0,
  "/onboarding/phone": 1,
  "/onboarding/verify": 1,
  "/onboarding/birthdate": 2,
  "/onboarding/pin": 3,
  "/onboarding/done": 4,
};

/** Shared frame for sign-in and onboarding: gateway provider, a small note and progress. */
export function OnboardingShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const dev = useDevProvider();
  const current = STEP_BY_PATH[pathname.replace(/\/$/, "")] ?? 0;
  return (
    <GatewayProvider>
      <OnboardingLayout
        banner={
          dev ? (
            <Alert tone="info">Local development sign-in: no email or text message is really sent.</Alert>
          ) : (
            <Alert tone="info">A game account with fictional money. Never enter real card or bank details.</Alert>
          )
        }
        progress={<OnboardingProgress current={current} />}
      >
        {children}
      </OnboardingLayout>
    </GatewayProvider>
  );
}
