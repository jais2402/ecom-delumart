/** Helpers of the address book screens (PRD R5.2); no personal data is stored in the browser. */

const CHECKOUT_PATH = /^\/checkout\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only place the address book returns to: one of our own checkout pages; anything else is null. */
export function safeReturnPath(next: string | null | undefined): string | null {
  if (typeof next !== "string") return null;
  return CHECKOUT_PATH.test(next) ? next : null;
}

/** The address book's URL that comes back to a checkout after an address is added. */
export function addAddressHref(checkoutSessionId: string): string {
  return `/account/addresses?add=1&next=${encodeURIComponent(`/checkout/${checkoutSessionId}`)}`;
}

/** The value of the fictional delivery spot in a destination choice. */
export const FICTIONAL_SPOT = "FICTIONAL_SPOT";
