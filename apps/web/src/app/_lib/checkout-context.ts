import type { QuoteResponse, Speed } from "./api";

/**
 * What the checkout page needs to carry from the product page. There is no GET for a quote, so the
 * priced quotes (public amounts and ids, nothing secret) are kept in memory and mirrored to
 * sessionStorage so a reload of the checkout page still works. Never put a PIN or code here.
 */
export interface CheckoutContext {
  productId: string;
  productName: string;
  category: string;
  sellerId: string;
  /** Quotes by delivery speed; each is an immutable priced session of its own. */
  quotes: Partial<Record<Speed, QuoteResponse>>;
  speed: Speed;
}

const memory = new Map<string, CheckoutContext>();
const KEY = (id: string) => `dm.checkout.${id}`;

export function saveCheckoutContext(id: string, context: CheckoutContext): void {
  memory.set(id, context);
  try {
    sessionStorage.setItem(KEY(id), JSON.stringify(context));
  } catch {
    // storage blocked: memory is enough while the tab stays on the site
  }
}

export function loadCheckoutContext(id: string): CheckoutContext | null {
  const cached = memory.get(id);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(KEY(id));
    if (raw) {
      const parsed = JSON.parse(raw) as CheckoutContext;
      memory.set(id, parsed);
      return parsed;
    }
  } catch {
    // unreadable: treat as missing
  }
  return null;
}

export function clearCheckoutContext(id: string): void {
  memory.delete(id);
  try {
    sessionStorage.removeItem(KEY(id));
  } catch {
    // ignore
  }
}
