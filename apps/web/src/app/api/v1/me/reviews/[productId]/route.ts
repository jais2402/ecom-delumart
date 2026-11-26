import { myReview } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { myReviewView } from "@/server/reviews";

/**
 * GET /api/v1/me/reviews/{productId}: the private overlay of a product page's reviews: whether the
 * signed-in player may write a review (`eligible`, or `reason`: NOT_OWNER, SELLER, UNAVAILABLE,
 * ACCOUNT), the handle it would show under, and their own review (also when hidden by a moderator,
 * with the reason, or not yet public). `private, no-store`; never part of the public response.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.reviewReadActor }] },
  async ({ params, session }) => {
    const m = await myReview(webPool(), {
      authSessionId: session.id,
      productId: pathId(params, "productId"),
    });
    return { json: myReviewView(m) };
  },
);
