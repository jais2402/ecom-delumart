import { DomainError, normalizePhone } from "@delulu/core";
import { phoneNumberAttempt, phoneVerificationMode, recordPhoneVerified } from "@delulu/db/runtime";
import { z } from "zod";
import { authProvider } from "@/server/auth";
import { requireChallenge } from "@/server/captcha";
import { clientAddress } from "@/server/client-address";
import { emailFingerprint, phoneFingerprint } from "@/server/crypto";
import { payPool, webPool } from "@/server/db";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { enforceRate, RATE_RULES, rateAllowed } from "@/server/rate-limit";
import { onboardingView } from "@/server/views";

/** The one answer for every reason a code could not be sent (ninth review, major 1a). */
const PHONE_NOT_SENT_MESSAGE =
  "We couldn't send a code to that number right now. Try again in a few minutes or use a different number.";

/**
 * POST /api/v1/onboarding/phone {phone, challenge?}: the Turnstile challenge first (when the
 * deployment asks for one), then the number is validated (PHONE_INVALID) and counted: at most a
 * few DISTINCT numbers per account (the database: 3 a day, 5 before onboarding completes) and per
 * client address (RATE_LIMITED beyond). Then, by the database's phone verification mode (0070):
 *  - 'sms' (default): at most 3 texts an hour and 5 a day to one number across all accounts (the
 *    subject is a keyed digest of the number); the sign-in service sends a code. The answer is
 *    {sent: true} only when a code went out; otherwise {sent: false, message} with ONE neutral
 *    message for every reason (the number is held elsewhere, a limit, the SMS provider), so it
 *    never reveals that another account holds the number; the reason is logged, never shown. In
 *    development the answer carries devCode "000000" (AUTH_PROVIDER=dev only).
 *  - 'unverified': records the number at once WITHOUT a code (fingerprint; one account per number,
 *    see 0075 for how unverified claims lapse); the profile is marked unverified. The answer is
 *    {recorded: true, onboarding} and onboarding.phoneVerified stays false.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ phone: z.string().min(1).max(32), challenge: z.string().max(4096).optional() }),
    rateLimits: [{ rule: RATE_RULES.phoneCodeAddress }, { rule: RATE_RULES.phoneCodeActor }],
  },
  async ({ body, session, request }) => {
    await requireChallenge(body.challenge, "phone_code");
    const e164 = normalizePhone(body.phone);
    const fp = phoneFingerprint(e164);
    const attempt = await phoneNumberAttempt(webPool(), { authSessionId: session.id, phoneFingerprint: fp });
    if (attempt === "LIMIT") {
      throw new DomainError(
        "RATE_LIMITED",
        "You have tried too many different numbers. Use a number you tried before, or try again tomorrow.",
        { retryAfterSeconds: 86_400 },
      );
    }
    if (attempt === "NEW") {
      await enforceRate(RATE_RULES.phoneNumberAddress, clientAddress(request, env().trustedProxyHops));
    }
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
        phoneFingerprint: fp,
        emailFingerprint: emailFp,
      });
      return { json: { recorded: true, onboarding: onboardingView(status) } };
    }
    const notSent = (reason: string) => {
      console.error("[auth] phone code not sent", reason);
      return { json: { sent: false, message: PHONE_NOT_SENT_MESSAGE } };
    };
    // texts to one destination, whoever asks (the victim of a squat still receives the attacker's
    // texts; this bounds how many)
    if (
      !(await rateAllowed(RATE_RULES.phoneSmsDestinationHour, e164)) ||
      !(await rateAllowed(RATE_RULES.phoneSmsDestinationDay, e164))
    ) {
      return notSent("DESTINATION_LIMIT");
    }
    const result = await provider.sendPhoneCode(session.id, e164);
    if (!result.sent) return notSent(result.reason);
    return {
      json:
        env().authProvider === "dev" && result.devCode !== null
          ? { sent: true, devCode: result.devCode }
          : { sent: true },
    };
  },
);
