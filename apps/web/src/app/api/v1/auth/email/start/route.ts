import { normalizeEmail } from "@delulu/core";
import { z } from "zod";
import { requireSupabase, startFlow } from "@/server/auth/sign-in-session";
import { callbackUrl, supabaseSignIn } from "@/server/auth/supabase";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { enforceRate, RATE_RULES } from "@/server/rate-limit";
import { flowCookie } from "@/server/session";

/**
 * POST /api/v1/auth/email/start {email, next?}: asks Supabase to email a sign-in link and code to
 * the address (AUTH_PROVIDER=supabase only; NOT_FOUND otherwise). The answer is always
 * {next: "check-email"}: it never says whether the address has an account. Limits: per client
 * address and per email address (keyed fingerprint). Starts a sign-in flow bound to this browser
 * (sealed flow cookie: state, PKCE verifier, return path, a keyed hash of the address).
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.strictObject({ email: z.string().min(3).max(254), next: z.string().max(2048).optional() }),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ body }) => {
    requireSupabase();
    const { appOrigin } = env();
    const email = normalizeEmail(body.email); // VALIDATION_FAILED for a malformed address
    await enforceRate(RATE_RULES.signInEmail, email);
    const { flow, challenge, sealed } = startFlow("email", body.next, email);
    await supabaseSignIn.startEmail(email, {
      codeChallenge: challenge,
      redirectTo: callbackUrl(appOrigin, flow.state),
    });
    return {
      json: { next: "check-email" },
      setCookies: [flowCookie(sealed, appOrigin, SERVER_CONFIG.auth.flowTtlSeconds)],
    };
  },
);
