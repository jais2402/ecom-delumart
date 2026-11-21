import { setCouponStatus } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { couponStatusBody } from "@/server/merchant";
import { RATE_RULES } from "@/server/rate-limit";

/** POST /api/v1/studio/coupons/{id}/status {status}: pause, resume or end an own coupon. */
export const POST = route(
  { auth: "session", body: couponStatusBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, params, session }) => {
    const couponId = pathId(params);
    await setCouponStatus(webPool(), { authSessionId: session.id, couponId, status: body.status });
    return { json: { id: couponId, status: body.status } };
  },
);
