import { resolveAppeal } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminDecisionBody } from "@/server/safety";
import { adminTargetId } from "@/server/studio";
import { appealResolutionView } from "@/server/views";

/**
 * POST /api/v1/admin/appeals/{id}/resolve {outcome: UPHELD | DENIED, reason}: UPHELD restores a
 * hidden listing or returns a rejected one to draft (Super Admin only; audited).
 */
export const POST = route(
  {
    auth: "session",
    body: adminDecisionBody(["UPHELD", "DENIED"] as const),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ body, params, session }) => {
    const result = await resolveAppeal(webPool(), {
      authSessionId: session.id,
      appealId: adminTargetId(params.id),
      outcome: body.outcome,
      reason: body.reason,
    });
    return { json: appealResolutionView(result) };
  },
);
