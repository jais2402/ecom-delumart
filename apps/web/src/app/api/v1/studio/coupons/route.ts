import { createCoupon, myCoupons } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { checkCoupon, couponBody } from "@/server/merchant";
import { RATE_RULES } from "@/server/rate-limit";
import { merchantCouponView } from "@/server/views";

/** GET /api/v1/studio/coupons: the owner's coupons with their codes, redemptions and discount given. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const mine = await myCoupons(webPool(), { authSessionId: session.id });
  return {
    json: {
      items: mine.items.map(merchantCouponView),
      activeCount: mine.activeCount,
      activeMax: mine.activeMax,
    },
  };
});

/**
 * POST /api/v1/studio/coupons {kind, value, minSpendRupees?, startsAt?, endsAt?, maxRedemptions?,
 * isPublic, publicCode?}: a coupon of the owner's store (a private one gets a generated code).
 * COUPON_LIMIT at five active coupons.
 */
export const POST = route(
  { auth: "session", body: couponBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, session }) => {
    const made = await createCoupon(webPool(), { authSessionId: session.id, coupon: checkCoupon(body) });
    return { status: 201, json: { id: made.couponId, code: made.code } };
  },
);
