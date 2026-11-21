import { cartRemove } from "@delulu/db/runtime";
import { cartResponse } from "@/server/cart";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/** DELETE /api/v1/cart/lines/{productId}: removes one line (absent is a no-op). */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.cartWriteActor }] },
  async ({ session, params }) => {
    await cartRemove(webPool(), { authSessionId: session.id, productId: pathId(params, "productId") });
    return { json: await cartResponse(session.id) };
  },
);
