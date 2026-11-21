import { DomainError } from "@delulu/core";
import { myOrder } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { orderView } from "@/server/views";

/** GET /api/v1/orders/{id}: one own order; someone else's is NOT_FOUND, like a missing one. */
export const GET = route({ auth: "session" }, async ({ session, params }) => {
  const order = await myOrder(webPool(), { authSessionId: session.id, orderGroupId: pathId(params) });
  if (order === null) throw new DomainError("NOT_FOUND", "Order not found.");
  return { json: orderView(order) };
});
