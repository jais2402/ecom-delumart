import { amountBucket, DomainError } from "@delulu/core";
import { cartIssues, PayFailure, payOutcome } from "@delulu/db/runtime";
import { z } from "zod";
import { trackAfter } from "@/server/analytics";
import { payPool, webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { receiptView } from "@/server/views";

/** Refusals caused by a line that can no longer be bought: the response names the cart's issues. */
const LINE_REFUSALS = new Set(["SOLD_OUT", "PRODUCT_UNAVAILABLE", "ALREADY_OWNED", "SELF_PURCHASE"]);

/**
 * POST /api/v1/checkout-sessions/{id}/pay {attemptId} (Idempotency-Key): the pay transaction.
 * Repeating it with the same key returns the same order (or the same failure). All-or-nothing: a
 * line sold out or hidden since the quote fails the payment with no debit, and the error's
 * `details.issues` lists the cart lines that can no longer be bought. A fresh (not replayed) order
 * records a `purchase` analytics event (and `creator_unlock` when it unlocked creator access), after
 * the commit and without the amount: only its bucket. Tracking runs after the response is sent
 * (trackAfter): the payment's answer never waits for it.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ attemptId: z.uuid() }),
    idempotencyKey: true,
    rateLimits: [{ rule: RATE_RULES.payActor }],
  },
  async ({ request, body, session, params, idempotencyKey }) => {
    try {
      const { receipt, replayed } = await payOutcome(payPool(), {
        authSessionId: session.id,
        sessionId: pathId(params),
        attemptId: body.attemptId.toLowerCase(),
        idempotencyKey,
      });
      if (!replayed) {
        const analytics = { surface: "checkout", authSessionId: session.id } as const;
        trackAfter(request, "purchase", { amount_bucket: amountBucket(receipt.totalPaise) }, analytics);
        if (receipt.creatorUnlocked) trackAfter(request, "creator_unlock", {}, analytics);
      }
      return { json: receiptView(receipt) };
    } catch (error) {
      if (error instanceof PayFailure && LINE_REFUSALS.has(error.code)) {
        const issues = await cartIssues(webPool(), { authSessionId: session.id });
        throw new DomainError(error.code, error.message, { ...error.details, issues });
      }
      throw error;
    }
  },
);
