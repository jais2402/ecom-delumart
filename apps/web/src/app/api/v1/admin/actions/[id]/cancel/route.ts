import { cancelAdminAction } from "@delulu/db/runtime";
import { actionView, cancelBody } from "@/server/admin-actions";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminTargetId } from "@/server/studio";

/**
 * POST /api/v1/admin/actions/{id}/cancel {reason}: cancels a delayed action that has not run yet
 * (Super Admin only; audited). CONFLICT once it has run or was cancelled. Cancelling only removes a
 * change, so it does not need a recent sign-in (decisions.md #16).
 */
export const POST = route(
  { auth: "session", body: cancelBody, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ body, params, session }) => {
    const action = await cancelAdminAction(webPool(), {
      authSessionId: session.id,
      actionId: adminTargetId(params.id),
      reason: body.reason,
    });
    return { json: { action: actionView(action) } };
  },
);
