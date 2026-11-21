import { createPaymentAttempt } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";

const body = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("BALANCE") }),
  z.strictObject({ method: z.literal("CARD"), cardId: z.uuid() }),
]);

/**
 * POST /api/v1/checkout-sessions/{id}/attempts {method, cardId?}: a payment attempt. BALANCE is
 * authenticated at once; CARD needs POST /attempts/{id}/pin. The card is named by its id only:
 * no route accepts a card number, expiry or CVV.
 */
export const POST = route({ auth: "session", body }, async ({ body: b, session, params }) => {
  const attempt = await createPaymentAttempt(payPool(), {
    authSessionId: session.id,
    sessionId: pathId(params),
    method: b.method,
    ...(b.method === "CARD" ? { cardId: b.cardId.toLowerCase() } : {}),
  });
  return {
    status: 201,
    json: {
      id: attempt.attemptId,
      reference: attempt.reference,
      method: attempt.method,
      authenticated: attempt.authenticated,
    },
  };
});
