import type { LineIssue, PreviewResponse, Speed } from "./api";
import { parsePaise } from "./money";

/** Plain-language reasons a line cannot be bought. */
export const ISSUE_TEXT: Record<LineIssue, string> = {
  UNAVAILABLE: "No longer available. It is left out of your total.",
  SOLD_OUT: "Sold out. It is left out of your total.",
  ALREADY_OWNED: "You already own this. It is left out of your total.",
  SELF_PURCHASE: "This is your own product, so you cannot buy it. It is left out of your total.",
};

export function issueText(issue: string): string {
  return (
    ISSUE_TEXT[issue as LineIssue] ?? "This item cannot be bought right now. It is left out of your total."
  );
}

export function couponText(code: string | null): string | undefined {
  if (code === null) return undefined;
  switch (code) {
    case "COUPON_INVALID":
      return "That code is not valid. Check it and try again.";
    case "COUPON_NOT_APPLICABLE":
      return "That coupon does not apply to the items in your cart.";
    default:
      return "That coupon cannot be used right now.";
  }
}

export function previewErrorText(code: string | null): string {
  switch (code) {
    case "DELIVERY_UNAVAILABLE":
      return "That delivery speed is not available for this seller. Your total is unchanged.";
    default:
      return "We could not work out your total just now. Try again in a moment.";
  }
}

export interface PreviewTotals {
  items: bigint;
  discount: bigint;
  delivery: bigint;
  total: bigint;
  balanceAfter: bigint | null;
}

/** Sums across sellers with BigInt; the total itself is the server's own figure. */
export function previewTotals(preview: PreviewResponse): PreviewTotals {
  let items = 0n;
  let discount = 0n;
  let delivery = 0n;
  for (const s of preview.sellers) {
    items += parsePaise(s.itemTotalPaise);
    discount += parsePaise(s.sellerDiscountPaise) + parsePaise(s.platformDiscountPaise);
    delivery += parsePaise(s.deliveryFeePaise);
  }
  return {
    items,
    discount,
    delivery,
    total: parsePaise(preview.totalPaise),
    balanceAfter: preview.balanceAfterPaise === null ? null : parsePaise(preview.balanceAfterPaise),
  };
}

export type CheckoutBlock =
  | { kind: "issues" }
  | { kind: "empty" }
  | { kind: "pricing" }
  | { kind: "loading" }
  | { kind: "balance"; shortfall: bigint };

/** Why the cart cannot be checked out right now, or null when it can. */
export function checkoutBlock(input: {
  issueCount: number;
  preview: PreviewResponse | null;
  previewError: boolean;
  loading: boolean;
}): CheckoutBlock | null {
  if (input.issueCount > 0) return { kind: "issues" };
  if (input.previewError || input.preview === null) return { kind: "pricing" };
  if (input.preview.sellers.length === 0) return { kind: "empty" };
  if (input.loading) return { kind: "loading" };
  const { balanceAfter } = previewTotals(input.preview);
  if (balanceAfter !== null && balanceAfter < 0n) return { kind: "balance", shortfall: -balanceAfter };
  return null;
}

/** The speed each seller currently shows: the person's choice, else what the preview priced. */
export function effectiveSpeeds(
  preview: PreviewResponse | null,
  chosen: Readonly<Record<string, Speed>>,
): Record<string, Speed> {
  const out: Record<string, Speed> = {};
  for (const s of preview?.sellers ?? []) out[s.sellerKey] = chosen[s.sellerKey] ?? s.speed;
  return out;
}
