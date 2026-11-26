import { hideReview } from "@delulu/db/runtime";
import { z } from "zod";
import { trackAfter } from "@/server/analytics";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminTargetId } from "@/server/studio";

/**
 * POST /api/v1/admin/reviews/{id}/hide {reason}: hides a review from the public list and the
 * aggregate at once (Super Admin only; audited). Records a `review_hidden` analytics event (no props).
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ reason: z.string().max(1000) }),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ request, body, params, session }) => {
    const r = await hideReview(webPool(), {
      authSessionId: session.id,
      reviewId: adminTargetId(params.id),
      reason: body.reason,
    });
    trackAfter(request, "review_hidden", {}, { surface: "console", authSessionId: session.id });
    return { json: { reviewId: r.reviewId, hidden: r.hidden } };
  },
);
