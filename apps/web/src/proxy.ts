import { type NextRequest, NextResponse } from "next/server";
import {
  contentSecurityPolicy,
  isPrivatePage,
  newNonce,
  PRIVATE_PAGE_CACHE,
  usesChallenge,
} from "./server/page-headers";

/**
 * Runs before every page request (not API routes or static files): a fresh CSP nonce, handed to
 * the renderer in the request's Content-Security-Policy header (Next.js reads the nonce from it and
 * puts it on its scripts) and sent to the browser in the response; private pages are never cached.
 */
export function proxy(request: NextRequest): NextResponse {
  const csp = contentSecurityPolicy(
    newNonce(),
    process.env.NODE_ENV !== "production",
    usesChallenge(request.nextUrl.pathname),
  );
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  if (isPrivatePage(request.nextUrl.pathname)) response.headers.set("Cache-Control", PRIVATE_PAGE_CACHE);
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static/|_next/image|favicon\\.ico).*)"],
};
