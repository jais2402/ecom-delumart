import { pay } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { receiptView } from "@/server/views";

/**
 * POST /api/v1/checkout-sessions/{id}/pay {attemptId} (Idempotency-Key): the pay transaction.
 * Repeating it with the same key returns the same order (or the same failure).
 */
export const POST = route(
  { auth: "session", body: z.strictObject({ attemptId: z.uuid() }), idempotencyKey: true },
  async ({ body, session, params, idempotencyKey }) => {
    const receipt = await pay(payPool(), {
      authSessionId: session.id,
      sessionId: pathId(params),
      attemptId: body.attemptId.toLowerCase(),
      idempotencyKey,
    });
    return { json: receiptView(receipt) };
  },
);
