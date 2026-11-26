import { createPaymentAttempt } from "@delulu/db/runtime";
import { trackAfter } from "@/server/analytics";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { attemptBody } from "@/server/payments";

/**
 * POST /api/v1/checkout-sessions/{id}/attempts {method, cardId? | delulupayId?, scenario?}: a payment
 * attempt. BALANCE is authenticated at once; CARD needs POST /attempts/{id}/pin; NET_BANKING and
 * DELULUPAY_ID need POST /checkout-sessions/{id}/challenge and /challenge/verify. The card is named by
 * its id only and a DeluluPay ID must end in @delulu: no route accepts a card number, expiry or CVV.
 * `scenario` (a forced test outcome, PRD R4.6) is refused unless the caller is staff or the owner has
 * switched scenarios on. Records `payment_method_selected` (the method only) after the attempt exists.
 */
export const POST = route(
  { auth: "session", body: attemptBody },
  async ({ request, body: b, session, params }) => {
    const attempt = await createPaymentAttempt(payPool(), {
      authSessionId: session.id,
      sessionId: pathId(params),
      method: b.method,
      ...(b.method === "CARD" ? { cardId: b.cardId.toLowerCase() } : {}),
      ...(b.method === "DELULUPAY_ID" ? { delulupayId: b.delulupayId } : {}),
      ...(b.scenario === undefined ? {} : { scenario: b.scenario }),
    });
    trackAfter(
      request,
      "payment_method_selected",
      { method: attempt.method },
      { surface: "checkout", authSessionId: session.id },
    );
    return {
      status: 201,
      json: {
        id: attempt.attemptId,
        reference: attempt.reference,
        method: attempt.method,
        authenticated: attempt.authenticated,
      },
    };
  },
);
