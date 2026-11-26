/**
 * The browser's analytics helper (PRD R16.5): fire-and-forget, same-origin, no cookies of its own,
 * no storage, no identifiers. One event per call to POST /api/v1/events, sent with sendBeacon (a
 * text/plain body, so no preflight) or, where that is unavailable, fetch with keepalive. Nothing
 * is sent when the browser signals Global Privacy Control or Do Not Track. The server adds the
 * place and device class and never takes them from here; a search sends only the query's length
 * and the number of results, never the query.
 */

export const EVENTS_PATH = "/api/v1/events";

export type ClientSurface = "shop" | "account" | "checkout" | "studio" | "console";

export interface ClientEventProps {
  page_view: Record<string, never>;
  search: { resultCount: number; queryLength: number };
  product_view: { productId: string };
  cart_add: { productId: string };
  checkout_start: { itemCount: number; totalPaise?: string };
}

export type ClientEventName = keyof ClientEventProps;

interface BrowserLike {
  navigator?: {
    sendBeacon?: (url: string, data: string) => boolean;
    globalPrivacyControl?: boolean;
    doNotTrack?: string | null;
  };
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

function browser(): BrowserLike | null {
  return typeof window === "undefined" ? null : (window as unknown as BrowserLike);
}

/** True when the browser asks not to be tracked. */
export function trackingDeclined(b: BrowserLike): boolean {
  return b.navigator?.globalPrivacyControl === true || b.navigator?.doNotTrack === "1";
}

/** True when this browser asks not to be tracked; other local conveniences (such as "Recently viewed") honour it too. */
export function trackingDeclinedHere(): boolean {
  const target = browser();
  return target !== null && trackingDeclined(target);
}

/** Sends one event; never throws and never waits. `target` is injectable for tests. */
export function trackClient<N extends ClientEventName>(
  name: N,
  props: ClientEventProps[N],
  surface: ClientSurface = "shop",
  target: BrowserLike | null = browser(),
): void {
  if (target === null || trackingDeclined(target)) return;
  const body = JSON.stringify({ name, surface, props });
  try {
    if (target.navigator?.sendBeacon?.(EVENTS_PATH, body) === true) return;
  } catch {
    // fall through to fetch
  }
  try {
    void target
      .fetch?.(EVENTS_PATH, {
        method: "POST",
        body,
        keepalive: true,
        credentials: "same-origin",
        headers: { "content-type": "text/plain;charset=UTF-8" },
      })
      ?.catch(() => undefined);
  } catch {
    // analytics never breaks the page
  }
}
