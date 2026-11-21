import { cartClear } from "@delulu/db/runtime";
import { cartResponse } from "@/server/cart";
import { webPool } from "@/server/db";
import { route } from "@/server/http";

/**
 * GET /api/v1/cart: the caller's cart grouped by seller, each line with its issue (if it can no
 * longer be bought), and a priced preview of the purchasable lines (STANDARD delivery, no coupon).
 * The cart reserves no stock and guarantees no price (PRD R2.2).
 */
export const GET = route({ auth: "session" }, async ({ session }) => ({
  json: await cartResponse(session.id),
}));

/** DELETE /api/v1/cart: empties the cart. */
export const DELETE = route({ auth: "session" }, async ({ session }) => {
  await cartClear(webPool(), { authSessionId: session.id });
  return { json: await cartResponse(session.id) };
});
