import type { PriceStep } from "@delulu/ui";

/** Whole-rupee thresholds for the price filters. */
export const PRICE_STEPS: readonly PriceStep[] = [
  { value: "1000", label: "₹1,000" },
  { value: "100000", label: "₹1 lakh" },
  { value: "1000000", label: "₹10 lakh" },
  { value: "10000000", label: "₹1 crore" },
  { value: "100000000", label: "₹10 crore" },
];
