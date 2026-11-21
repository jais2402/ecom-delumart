import { mySellerOrder } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { merchantOrderView } from "@/server/views";

/** GET /api/v1/studio/orders/{id}: one of the store's seller orders (another store's is 404). */
export const GET = route({ auth: "session" }, async ({ params, session }) => {
  const order = await mySellerOrder(webPool(), { authSessionId: session.id, sellerOrderId: pathId(params) });
  return { json: { order: merchantOrderView(order) } };
});
