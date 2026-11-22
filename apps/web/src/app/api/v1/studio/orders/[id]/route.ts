import { mySellerOrder } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { merchantOrderView } from "@/server/views";

/**
 * GET /api/v1/studio/orders/{reference}: one of the store's seller orders by its opaque reference
 * (0055). Another store's, an unknown and a malformed reference (a seller order id included) all
 * answer the same 404.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.studioReadActor }] },
  async ({ params, session }) => {
    const order = await mySellerOrder(webPool(), { authSessionId: session.id, orderRef: params.id ?? "" });
    return { json: { order: merchantOrderView(order) } };
  },
);
