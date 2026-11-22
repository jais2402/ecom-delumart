import "./server-only";

/**
 * Headers of HTML page responses, set by the proxy (src/proxy.ts) on every page request.
 *
 * Content-Security-Policy (LLD §11.1; fifth security review): scripts only from this origin and
 * only those carrying the per-request nonce (Next.js puts it on its own scripts when it renders a
 * page dynamically, which is why every page is rendered per request); 'strict-dynamic' lets those
 * load their chunks. <style> elements need the nonce too; style attributes stay allowed
 * (style-src-attr), since a nonce cannot cover an attribute and components set widths inline.
 * In development only, React's debugging eval, inline dev styles and the hot-reload websocket are
 * allowed.
 *
 * Cache-Control: every page that belongs to a signed-in person (or to signing in) is
 * `private, no-store`, so no shared cache keeps a shell of it.
 */
export const PRIVATE_PAGE_PREFIXES = [
  "/account",
  "/cart",
  "/checkout",
  "/orders",
  "/onboarding",
  "/sign-in",
  "/sell",
  "/studio",
  "/console",
] as const;
export const PRIVATE_PAGE_CACHE = "private, no-store";

export function isPrivatePage(pathname: string): boolean {
  return PRIVATE_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Cloudflare Turnstile (ninth review, major 2a): its script and its iframe come from this origin
 * only, and only the pages that render the challenge widget allow it.
 */
export const CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";
export const CHALLENGE_PAGES = ["/sign-in", "/onboarding/phone", "/onboarding/verify"] as const;

export function usesChallenge(pathname: string): boolean {
  return (CHALLENGE_PAGES as readonly string[]).includes(pathname.replace(/\/$/, "") || "/");
}

export function contentSecurityPolicy(nonce: string, development: boolean, challenge = false): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error("a nonce is at least 16 base64 characters");
  // with 'strict-dynamic' a CSP3 browser trusts the widget script because a nonced script adds it;
  // the host is listed for browsers without 'strict-dynamic'
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${challenge ? ` ${CHALLENGE_ORIGIN}` : ""}${development ? " 'unsafe-eval'" : ""}`,
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    development ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    ...(challenge ? [`frame-src ${CHALLENGE_ORIGIN}`] : []),
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** 128 random bits, base64: a fresh nonce for every page request. */
export function newNonce(
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  const bytes = random(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
