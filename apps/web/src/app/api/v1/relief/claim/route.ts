import { claimRelief } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { reliefClaimView } from "@/server/views";

/**
 * POST /api/v1/relief/claim {productId}: saves a published product never saved before and claims
 * today's ₹10 lakh relief grant. Refuses RELIEF_NOT_ELIGIBLE, RELIEF_LIMIT, CONFLICT (saved
 * before), PRODUCT_UNAVAILABLE.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ productId: z.uuid() }),
    rateLimits: [{ rule: RATE_RULES.reliefActor }],
  },
  async ({ body, session }) => {
    const claim = await claimRelief(payPool(), {
      authSessionId: session.id,
      productId: body.productId.toLowerCase(),
    });
    return { json: reliefClaimView(claim) };
  },
);
