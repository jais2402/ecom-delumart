import { normalizePhone } from "@delulu/core";
import { z } from "zod";
import { authProvider } from "@/server/auth";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { LIMITERS } from "@/server/rate-limit";

/**
 * POST /api/v1/onboarding/phone {phone}: validates the number (PHONE_INVALID) and asks the sign-in
 * service to send a code. In development there is no SMS: the answer carries devCode "000000",
 * and only when AUTH_PROVIDER is 'dev'.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ phone: z.string().min(1).max(32) }),
    rateLimit: { limiter: LIMITERS.phoneCode, by: "session" },
  },
  async ({ body, session }) => {
    const e164 = normalizePhone(body.phone);
    const { devCode } = await (await authProvider()).sendPhoneCode(session.id, e164);
    return {
      json: env().authProvider === "dev" && devCode !== null ? { sent: true, devCode } : { sent: true },
    };
  },
);
