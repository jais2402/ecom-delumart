import { resolveReportCase } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminDecisionBody } from "@/server/safety";
import { adminTargetId } from "@/server/studio";
import { caseResolutionView } from "@/server/views";

/**
 * POST /api/v1/admin/reports/{id}/resolve {outcome: UPHELD | DISMISSED, reason}: UPHELD hides a
 * reported product; DISMISSED restores one the reports hid (Super Admin only; audited).
 */
export const POST = route(
  {
    auth: "session",
    body: adminDecisionBody(["UPHELD", "DISMISSED"] as const),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ body, params, session }) => {
    const result = await resolveReportCase(webPool(), {
      authSessionId: session.id,
      caseId: adminTargetId(params.id),
      outcome: body.outcome,
      reason: body.reason,
    });
    return { json: caseResolutionView(result) };
  },
);
