import { normalizeEmail } from "@delulu/core";
import { z } from "zod";
import { requireSupabase, startFlow } from "@/server/auth/sign-in-session";
import { confirmUrl, supabaseSignIn } from "@/server/auth/supabase";
import { requireChallenge } from "@/server/captcha";
import { clientAddress, clientNetworkKey } from "@/server/client-address";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { enforceRate, RATE_RULES } from "@/server/rate-limit";
import { flowCookie } from "@/server/session";

/**
 * POST /api/v1/auth/email/start {email, next?, challenge?}: asks Supabase to email a sign-in link
 * and code to the address (AUTH_PROVIDER=supabase only; NOT_FOUND otherwise). The answer is always
 * {next: "check-email"}: it never says whether the address has an account.
 *
 * Order (ninth review, major 2): the per-address limit, then the Turnstile challenge (when the
 * deployment asks for one; CAPTCHA_FAILED otherwise), and only then the per-email limits, so only
 * requests that passed the challenge count against an address: per (email, client network: IPv4
 * /24, IPv6 /64) and a higher ceiling per email from every network together, so a stranger
 * elsewhere cannot cheaply use up the owner's own allowance. Starts a sign-in flow bound to this
 * browser (sealed flow cookie: state, PKCE verifier, return path, a keyed hash of the address).
 * The emailed link leads to /sign-in/confirm, where a button press (POST) redeems it.
 */
export const POST = route(
  {
    auth: "anonymous",
    body: z.strictObject({
      email: z.string().min(3).max(254),
      next: z.string().max(2048).optional(),
      challenge: z.string().max(4096).optional(),
    }),
    rateLimits: [{ rule: RATE_RULES.signInAddress }],
    preSessionCsrf: true,
  },
  async ({ body, request }) => {
    requireSupabase();
    const { appOrigin, trustedProxyHops } = env();
    const email = normalizeEmail(body.email); // VALIDATION_FAILED for a malformed address
    await requireChallenge(body.challenge, "email_start");
    const network = clientNetworkKey(clientAddress(request, trustedProxyHops));
    await enforceRate(RATE_RULES.signInEmailClient, `${email}\0${network}`);
    await enforceRate(RATE_RULES.signInEmail, email);
    const { challenge, sealed } = startFlow("email", body.next, email);
    await supabaseSignIn.startEmail(email, { codeChallenge: challenge, redirectTo: confirmUrl(appOrigin) });
    return {
      json: { next: "check-email" },
      setCookies: [flowCookie(sealed, appOrigin, SERVER_CONFIG.auth.flowTtlSeconds)],
    };
  },
);
