import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { StepIndicator } from "../../molecules/StepIndicator";

export const CHECKOUT_STEPS = ["Delivery", "Speed", "Payment", "Review"] as const;

export type CheckoutStepsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  /** Zero-based index into Delivery, Speed, Payment, Review. */
  current: number;
};

export function CheckoutSteps({ current, className, ...props }: CheckoutStepsProps) {
  return (
    <nav aria-label="Checkout progress" className={cn(className)} {...props}>
      <StepIndicator steps={CHECKOUT_STEPS} current={current} />
    </nav>
  );
}
