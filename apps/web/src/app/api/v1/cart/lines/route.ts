import { cartAdd } from "@delulu/db/runtime";
import { z } from "zod";
import { cartResponse } from "@/server/cart";
import { webPool } from "@/server/db";
import { route } from "@/server/http";

/**
 * POST /api/v1/cart/lines {productId}: adds a published product (quantity one; already in the
 * cart is a no-op). Refuses PRODUCT_UNAVAILABLE, ALREADY_OWNED, SELF_PURCHASE or CART_FULL.
 */
export const POST = route(
  { auth: "session", body: z.strictObject({ productId: z.uuid() }) },
  async ({ body, session }) => {
    await cartAdd(webPool(), { authSessionId: session.id, productId: body.productId.toLowerCase() });
    return { json: await cartResponse(session.id) };
  },
);
