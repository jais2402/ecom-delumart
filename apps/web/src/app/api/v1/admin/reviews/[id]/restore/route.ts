import { restoreReview } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminTargetId } from "@/server/studio";

/** POST /api/v1/admin/reviews/{id}/restore {reason}: shows a hidden review again (Super Admin only; audited). */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ reason: z.string().max(1000) }),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ body, params, session }) => {
    const r = await restoreReview(webPool(), {
      authSessionId: session.id,
      reviewId: adminTargetId(params.id),
      reason: body.reason,
    });
    return { json: { reviewId: r.reviewId, hidden: r.hidden } };
  },
);
