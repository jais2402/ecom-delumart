import { cancelPaymentAttempt } from "@delulu/db/runtime";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";

/** POST /api/v1/attempts/{id}/cancel: "cancelled by you" ends the caller's own pending attempt; no money moves. */
export const POST = route({ auth: "session" }, async ({ session, params }) => {
  const r = await cancelPaymentAttempt(payPool(), { authSessionId: session.id, attemptId: pathId(params) });
  return { json: { attemptId: r.attemptId, status: "FAILED", failureCode: "CANCELLED" } };
});
