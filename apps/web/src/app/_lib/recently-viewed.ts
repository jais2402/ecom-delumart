import { trackingDeclinedHere } from "./analytics";
import { SHOP_CONFIG } from "./shop-config";

/**
 * "Recently viewed": the last few product ids the shopper opened, kept in this browser only
 * (sessionStorage, ids and nothing else: the cart e2e spec requires localStorage to hold only the cart key) and never sent anywhere. Nothing is read or written when the
 * browser signals Global Privacy Control or Do Not Track, the same signals the analytics honour.
 */
export const RECENT_KEY = "dm.recent.v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Puts `id` first, drops an earlier copy, keeps at most `max`. Pure. */
export function pushRecent(ids: readonly string[], id: string, max: number): string[] {
  const key = id.toLowerCase();
  return [key, ...ids.filter((existing) => existing !== key)].slice(0, max);
}

export function readRecent(): string[] {
  if (trackingDeclinedHere()) return [];
  try {
    const raw = sessionStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((v): v is string => typeof v === "string" && UUID.test(v));
    return [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, SHOP_CONFIG.recent.remember);
  } catch {
    return [];
  }
}

export function recordViewed(productId: string): void {
  if (trackingDeclinedHere() || !UUID.test(productId)) return;
  try {
    sessionStorage.setItem(
      RECENT_KEY,
      JSON.stringify(pushRecent(readRecent(), productId, SHOP_CONFIG.recent.remember)),
    );
  } catch {
    // storage can be blocked; the rail just stays empty
  }
}
