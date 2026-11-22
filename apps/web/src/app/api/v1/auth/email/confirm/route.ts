import { DomainError } from "@delulu/core";
import { z } from "zod";
import { readFlow, requireSupabase, signedInCookies } from "@/server/auth/sign-in-session";
import { SignInRefused, supabaseSignIn } from "@/server/auth/supabase";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

const REFUSED =
  "That sign-in link did not work. It may have expired or been used already, or it was opened in a different browser. Ask for a new one.";

/**
 * POST /api/v1/auth/email/confirm (ninth review, minor 6c): the button on /sign-in/confirm. The
 * emailed link only OPENS that page (a GET, which mail scanners may fetch freely); the link's token
 * is redeemed here, on a POST the person makes, never on a GET:
 *  - {tokenHash, type} (the email template's `{{ .TokenHash }}` link): `type` must be one of the
 *    email link types and the hash must look like one; Supabase verifies it and the session is
 *    accepted only when its user's email is the address this browser's flow was started for;
 *  - {code} (a link that went through Supabase's own verify page): exchanged with this browser's
 *    PKCE verifier.
 * Either way the flow cookie of THIS browser (state, verifier, email binding) is required, the
 * same CSRF rules as the other sign-in calls apply, and the answer's return path is the flow's
 * already-checked same-origin path. One answer for every failure.
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.union([
      z.strictObject({
        tokenHash: z.string().regex(/^(pkce_)?[0-9a-f]{40,128}$/),
        type: z.enum(["email", "magiclink", "signup"]),
      }),
      z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{8,512}$/) }),
    ]),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ request, body }) => {
    requireSupabase();
    const flow = readFlow(request);
    if (flow === null || flow.kind !== "email" || flow.emailBinding === null) {
      throw new DomainError("VALIDATION_FAILED", REFUSED);
    }
    let signedIn: { sessionId: string } | null;
    try {
      signedIn =
        "code" in body
          ? await supabaseSignIn.exchange(body.code, flow.verifier)
          : await supabaseSignIn.confirmEmailLink(body.type, body.tokenHash, flow.emailBinding);
    } catch (error) {
      if (error instanceof SignInRefused) throw new DomainError("VALIDATION_FAILED", REFUSED);
      throw error;
    }
    if (signedIn === null) throw new DomainError("VALIDATION_FAILED", REFUSED);
    const { csrfToken, cookies } = await signedInCookies(request, signedIn.sessionId);
    return { json: { signedIn: true, csrfToken, next: flow.returnTo }, setCookies: cookies };
  },
);
