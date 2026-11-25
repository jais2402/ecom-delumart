import { DomainError } from "@delulu/core";
import { z } from "zod";
import { requireSupabase, startFlow } from "@/server/auth/sign-in-session";
import { callbackUrl, supabaseSignIn } from "@/server/auth/supabase";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { flowCookie } from "@/server/session";

/**
 * POST /api/v1/auth/google/start {next?}: starts a Google sign-in through Supabase (PKCE) bound to
 * this browser, and answers the URL to send the browser to. AUTH_PROVIDER=supabase only.
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.strictObject({ next: z.string().max(2048).optional() }),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ body }) => {
    requireSupabase();
    const { appOrigin, googleSignIn } = env();
    if (!googleSignIn) throw new DomainError("NOT_FOUND", "Not found.");
    const { flow, challenge, sealed } = startFlow("google", body.next, null);
    const url = supabaseSignIn.googleUrl({
      codeChallenge: challenge,
      redirectTo: callbackUrl(appOrigin, flow.state),
    });
    return { json: { url }, setCookies: [flowCookie(sealed, appOrigin, SERVER_CONFIG.auth.flowTtlSeconds)] };
  },
);
