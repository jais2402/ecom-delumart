import { DomainError, normalizePhone } from "@delulu/core";
import { phoneVerificationMode, recordPhoneVerified } from "@delulu/db/runtime";
import { z } from "zod";
import { authProvider } from "@/server/auth";
import { emailFingerprint, phoneFingerprint } from "@/server/crypto";
import { payPool, webPool } from "@/server/db";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { onboardingView } from "@/server/views";

/**
 * POST /api/v1/onboarding/phone {phone}: validates the number (PHONE_INVALID), then, by the
 * database's phone verification mode (an owner setting, migration 0070):
 *  - 'sms' (default): asks the sign-in service to send a code; the answer is {sent: true}. In
 *    development there is no SMS: the answer carries devCode "000000", only when AUTH_PROVIDER is 'dev'.
 *  - 'unverified': records the number at once WITHOUT a code: its keyed fingerprint (one account per
 *    number still holds; CONFLICT otherwise) and the profile marked phone_verified = false. The
 *    answer is {recorded: true, onboarding}.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ phone: z.string().min(1).max(32) }),
    rateLimits: [{ rule: RATE_RULES.phoneCodeAddress }, { rule: RATE_RULES.phoneCodeActor }],
  },
  async ({ body, session }) => {
    const e164 = normalizePhone(body.phone);
    const provider = await authProvider();
    if ((await phoneVerificationMode(webPool())) === "unverified") {
      let emailFp = session.actor.profile?.emailFingerprint ?? null;
      if (emailFp === null) {
        const email = await provider.verifiedEmail(session.id);
        if (email === null) throw new DomainError("AUTH_REQUIRED", "Sign in again to continue.");
        emailFp = emailFingerprint(email);
      }
      const status = await recordPhoneVerified(payPool(), {
        authSessionId: session.id,
        phoneFingerprint: phoneFingerprint(e164),
        emailFingerprint: emailFp,
      });
      return { json: { recorded: true, onboarding: onboardingView(status) } };
    }
    const { devCode } = await provider.sendPhoneCode(session.id, e164);
    return {
      json: env().authProvider === "dev" && devCode !== null ? { sent: true, devCode } : { sent: true },
    };
  },
);
