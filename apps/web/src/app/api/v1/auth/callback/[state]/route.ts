import { timingSafeEqual } from "node:crypto";
import { DomainError } from "@delulu/core";
import { readFlow, signedInCookies } from "@/server/auth/sign-in-session";
import { SignInRefused, supabaseSignIn } from "@/server/auth/supabase";
import { clientAddress } from "@/server/client-address";
import { env } from "@/server/env";
import { enforceRate, RATE_RULES } from "@/server/rate-limit";
import { clearedFlowCookie } from "@/server/session";

/**
 * GET /api/v1/auth/callback/{state}?code=…: where Supabase sends the browser back after Google. An
 * EMAIL flow is refused here (ninth review, minor 6c): emailed links lead to /sign-in/confirm and
 * are redeemed only by the POST its button makes, so no GET (a mail scanner's) ever signs in. The state in the path must equal the one sealed in this browser's flow cookie
 * (constant-time compare); the code is exchanged on the server with the flow's PKCE verifier
 * (Supabase accepts each code once); the access token is verified and DROPPED; the database must
 * see the session as live. Then the opaque session cookie is set and the browser goes on to
 * /sign-in/continue?next=<the flow's checked return path>. Any failure: back to /sign-in with a
 * generic error, the flow cleared, nothing signed in. Never cached; no Referer leaves this page.
 */
export const dynamic = "force-dynamic";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

export async function GET(
  request: Request,
  context: { params: Promise<Record<string, string | string[] | undefined>> },
): Promise<Response> {
  let appOrigin = "";
  try {
    const config = env();
    appOrigin = config.appOrigin;
    const failed = (reason: "link" | "busy") =>
      redirect(`${appOrigin}/sign-in?error=${reason}`, [clearedFlowCookie(appOrigin)]);
    if (config.authProvider !== "supabase" || config.supabase === null) return failed("link");
    try {
      await enforceRate(RATE_RULES.signInAddress, clientAddress(request, config.trustedProxyHops));
    } catch {
      return failed("busy");
    }
    const params = await context.params;
    const state = typeof params.state === "string" ? params.state : "";
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const flow = readFlow(request);
    if (
      flow === null ||
      flow.kind !== "google" ||
      !same(state, flow.state) ||
      !/^[A-Za-z0-9_-]{8,512}$/.test(code)
    )
      return failed("link");
    let signedIn: { sessionId: string } | null;
    try {
      signedIn = await supabaseSignIn.exchange(code, flow.verifier);
    } catch (error) {
      if (error instanceof SignInRefused) return failed("link");
      if (error instanceof DomainError && error.code === "BUSY") return failed("busy");
      throw error;
    }
    if (signedIn === null) return failed("link");
    const { cookies } = await signedInCookies(request, signedIn.sessionId);
    return redirect(`${appOrigin}/sign-in/continue?next=${encodeURIComponent(flow.returnTo)}`, cookies);
  } catch (error) {
    console.error("[auth] callback failed", (error as Error | null)?.name ?? "error");
    return redirect(`${appOrigin || ""}/sign-in?error=busy`, appOrigin ? [clearedFlowCookie(appOrigin)] : []);
  }
}
