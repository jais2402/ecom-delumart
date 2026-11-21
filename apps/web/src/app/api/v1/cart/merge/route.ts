import { cartMerge } from "@delulu/db/runtime";
import { z } from "zod";
import { cartResponse } from "@/server/cart";
import { SERVER_CONFIG } from "@/server/config";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { cartMergeSkipView } from "@/server/views";

/**
 * POST /api/v1/cart/merge {productIds}: at sign-in, merges the signed-out browser cart into the
 * account cart. Eligible products are added while there is room; the others are skipped, each
 * with a reason code (PRODUCT_UNAVAILABLE, ALREADY_OWNED, SELF_PURCHASE, CART_FULL).
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ productIds: z.array(z.uuid()).max(SERVER_CONFIG.http.maxCartLines) }),
    rateLimits: [{ rule: RATE_RULES.cartWriteActor }],
  },
  async ({ body, session }) => {
    const { skipped } = await cartMerge(webPool(), {
      authSessionId: session.id,
      productIds: body.productIds.map((id) => id.toLowerCase()),
    });
    return { json: { ...(await cartResponse(session.id)), skipped: skipped.map(cartMergeSkipView) } };
  },
);
