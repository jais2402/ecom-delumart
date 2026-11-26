import { DomainError, isPaymentMethod } from "@delulu/core";
import { verifyPaymentChallenge } from "@delulu/db/runtime";
import { trackAfter } from "@/server/analytics";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { verifyBody } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * POST /api/v1/checkout-sessions/{id}/challenge/verify {code} | {decision: APPROVE|DECLINE}: answers the
 * bank step. A correct code (or an approval) authenticates the attempt; then POST .../pay. Three wrong
 * codes fail the payment (CHALLENGE_LOCKED); an expired code is CHALLENGE_EXPIRED; each says that no
 * fictional money moved. The code is exactly six digits and is never logged or echoed. `WAITING` is a
 * (test) slow bank: ask again after `retryAfterSeconds`.
 */
export const POST = route(
  { auth: "session", body: verifyBody, rateLimits: [{ rule: RATE_RULES.challengeVerifyActor }] },
  async ({ request, body, session, params }) => {
    const analytics = { surface: "checkout", authSessionId: session.id } as const;
    const input = "code" in body ? { code: body.code } : { decision: body.decision };
    try {
      const outcome = await verifyPaymentChallenge(payPool(), {
        authSessionId: session.id,
        sessionId: pathId(params),
        ...input,
      });
      if (outcome.status === "AUTHENTICATED") {
        trackAfter(request, "payment_challenge_passed", { method: outcome.method }, analytics);
      } else if (outcome.status === "DECLINED") {
        trackAfter(request, "payment_challenge_failed", { method: outcome.method }, analytics);
      }
      return {
        json:
          outcome.status === "WAITING"
            ? { status: outcome.status, retryAfterSeconds: outcome.retryAfterSeconds }
            : { status: outcome.status, attemptId: outcome.attemptId },
      };
    } catch (error) {
      const method = error instanceof DomainError ? error.details.method : undefined;
      if (isPaymentMethod(method)) trackAfter(request, "payment_challenge_failed", { method }, analytics);
      throw error;
    }
  },
);
