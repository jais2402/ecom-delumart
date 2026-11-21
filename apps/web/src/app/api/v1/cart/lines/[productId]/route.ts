import { cartRemove } from "@delulu/db/runtime";
import { cartResponse } from "@/server/cart";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";

/** DELETE /api/v1/cart/lines/{productId}: removes one line (absent is a no-op). */
export const DELETE = route({ auth: "session" }, async ({ session, params }) => {
  await cartRemove(webPool(), { authSessionId: session.id, productId: pathId(params, "productId") });
  return { json: await cartResponse(session.id) };
});
