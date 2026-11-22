import "./server-only";

/**
 * The session cookie (LLD §11.1). The browser holds only an opaque cookie whose value is the
 * auth.sessions id; the database derives the user from it on every call. The id is a bearer
 * secret: it is written into this cookie and passed to the database, never logged, echoed in a
 * body or put in an error.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for plain-http local development on http://localhost[:port]. This is the ONLY place
 * the cookie may lose its __Host- prefix and Secure attribute (browsers refuse both over http).
 */
export function isLocalHttpOrigin(appOrigin: string): boolean {
  const url = new URL(appOrigin);
  return url.protocol === "http:" && url.hostname === "localhost";
}

export interface CookieNames {
  session: string;
  csrf: string;
  /** The sign-in flow in progress (auth/flow.ts): sealed state, PKCE verifier and return path. */
  flow: string;
}

export function cookieNames(appOrigin: string): CookieNames {
  return isLocalHttpOrigin(appOrigin)
    ? { session: "dm_session", csrf: "dm_csrf", flow: "dm_auth_flow" }
    : { session: "__Host-dm_session", csrf: "__Host-dm_csrf", flow: "__Host-dm_auth_flow" };
}

/** HttpOnly; SameSite=Lax; Path=/; no Domain; Secure except on http://localhost. */
function serialize(name: string, value: string, appOrigin: string, maxAgeSeconds: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (maxAgeSeconds === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (!isLocalHttpOrigin(appOrigin)) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookie(sessionId: string, appOrigin: string, maxAgeSeconds: number): string {
  if (!UUID.test(sessionId)) throw new Error("session id must be a uuid");
  return serialize(cookieNames(appOrigin).session, sessionId, appOrigin, maxAgeSeconds);
}

export function clearedSessionCookie(appOrigin: string): string {
  return serialize(cookieNames(appOrigin).session, "", appOrigin, 0);
}

/** The sealed sign-in flow (base64url); short-lived. */
export function flowCookie(sealed: string, appOrigin: string, maxAgeSeconds: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sealed)) throw new Error("flow cookie value must be base64url");
  return serialize(cookieNames(appOrigin).flow, sealed, appOrigin, maxAgeSeconds);
}

export function clearedFlowCookie(appOrigin: string): string {
  return serialize(cookieNames(appOrigin).flow, "", appOrigin, 0);
}

export function csrfCookie(token: string, appOrigin: string, maxAgeSeconds: number): string {
  return serialize(cookieNames(appOrigin).csrf, token, appOrigin, maxAgeSeconds);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** The session id from the cookie when it is shaped like one; the database decides if it is live. */
export function readSessionId(request: Request, appOrigin: string): string | null {
  const value = readCookie(request, cookieNames(appOrigin).session);
  return value !== null && UUID.test(value) ? value.toLowerCase() : null;
}
