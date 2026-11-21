import { restoreListing } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminTargetId } from "@/server/studio";
import { moderationOutcomeView } from "@/server/views";

/** POST /api/v1/admin/listings/{id}/restore {reason}: HIDDEN -> PUBLISHED (Super Admin only). */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ reason: z.string().max(1000) }),
    rateLimits: [{ rule: RATE_RULES.adminActor }],
  },
  async ({ body, params, session }) => {
    const outcome = await restoreListing(webPool(), {
      authSessionId: session.id,
      productId: adminTargetId(params.id),
      reason: body.reason,
    });
    return { json: moderationOutcomeView(outcome) };
  },
);
