import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { StepIndicator } from "../../molecules/StepIndicator";

export const ONBOARDING_STEPS = ["Sign in", "Phone", "Birthdate", "PIN", "Done"] as const;

export type OnboardingProgressProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  /** Zero-based index into ONBOARDING_STEPS. */
  current: number;
};

export function OnboardingProgress({ current, className, ...props }: OnboardingProgressProps) {
  return (
    <nav aria-label="Sign-up progress" className={cn("w-full", className)} {...props}>
      <StepIndicator steps={ONBOARDING_STEPS} current={current} className="gap-x-3" />
    </nav>
  );
}
