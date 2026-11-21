import { DomainError } from "@delulu/core";
import { recordPhoneVerified } from "@delulu/db/runtime";
import { z } from "zod";
import { authProvider } from "@/server/auth";
import { emailFingerprint, phoneFingerprint } from "@/server/crypto";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { LIMITERS } from "@/server/rate-limit";
import { onboardingView } from "@/server/views";

const MESSAGES = {
  NO_CODE_REQUESTED: "Request a code first.",
  WRONG_CODE: "That code is not right. Check it and try again.",
  TOO_MANY_TRIES: "Too many wrong codes. Request a new code.",
} as const;

/**
 * POST /api/v1/onboarding/phone/verify {code}: the sign-in service checks the code; then the
 * verified number's fingerprint is recorded (creating the profile with the email fingerprint).
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ code: z.string().regex(/^\d{6}$/) }),
    rateLimit: { limiter: LIMITERS.phoneCode, by: "session" },
  },
  async ({ body, session }) => {
    const provider = await authProvider();
    const result = await provider.verifyPhoneCode(session.id, body.code);
    if (!result.ok)
      throw new DomainError("PHONE_CODE_FAILED", MESSAGES[result.reason], { reason: result.reason });
    let emailFp = session.actor.profile?.emailFingerprint ?? null;
    if (emailFp === null) {
      const email = await provider.verifiedEmail(session.id);
      if (email === null) throw new DomainError("AUTH_REQUIRED", "Sign in again to continue.");
      emailFp = emailFingerprint(email);
    }
    const status = await recordPhoneVerified(payPool(), {
      authSessionId: session.id,
      phoneFingerprint: phoneFingerprint(result.e164),
      emailFingerprint: emailFp,
    });
    return { json: { onboarding: onboardingView(status) } };
  },
);
