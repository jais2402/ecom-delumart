import { myPaymentAttempt } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { attemptView } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/** GET /api/v1/attempts/{id}: one of the caller's own payment attempts (the bank page); never a code. */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.paymentReadActor }] },
  async ({ session, params }) => {
    const a = await myPaymentAttempt(webPool(), { authSessionId: session.id, attemptId: pathId(params) });
    return { json: attemptView(a) };
  },
);
