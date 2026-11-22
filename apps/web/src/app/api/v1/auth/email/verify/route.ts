import { DomainError, normalizeEmail } from "@delulu/core";
import { z } from "zod";
import { flowIsFor, readFlow, requireSupabase, signedInCookies } from "@/server/auth/sign-in-session";
import { SignInRefused, supabaseSignIn } from "@/server/auth/supabase";
import { SERVER_CONFIG } from "@/server/config";
import { route } from "@/server/http";
import { enforceRate, RATE_RULES } from "@/server/rate-limit";

const REFUSED = "That code is not right or has expired. Check it, or ask for a new email.";

/**
 * POST /api/v1/auth/email/verify {email, code}: the code from the sign-in email, typed in the
 * browser that asked for it (the flow cookie must be this browser's flow for this address). On
 * success the session cookie and a session-bound CSRF token; Supabase's tokens never leave the
 * server. One answer for every failure.
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.strictObject({
      email: z.string().min(3).max(254),
      code: z.string().regex(new RegExp(`^\\d{6,${SERVER_CONFIG.auth.emailCodeMaxDigits}}$`)),
    }),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ request, body }) => {
    requireSupabase();
    const email = normalizeEmail(body.email);
    await enforceRate(RATE_RULES.signInCodeEmail, email);
    const flow = readFlow(request);
    if (flow === null || !flowIsFor(flow, email)) throw new DomainError("VALIDATION_FAILED", REFUSED);
    let signedIn: { sessionId: string } | null;
    try {
      signedIn = await supabaseSignIn.verifyEmailCode(email, body.code);
    } catch (error) {
      if (error instanceof SignInRefused) throw new DomainError("VALIDATION_FAILED", REFUSED);
      throw error;
    }
    if (signedIn === null) throw new DomainError("VALIDATION_FAILED", REFUSED);
    const { csrfToken, cookies } = await signedInCookies(request, signedIn.sessionId);
    return { json: { signedIn: true, csrfToken, next: flow.returnTo }, setCookies: cookies };
  },
);
