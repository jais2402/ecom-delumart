import { DomainError } from "@delulu/core";
import { myOrder, myOrderDelivery } from "@delulu/db/runtime";
import { orderDeliveryView } from "@/server/address";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { orderView } from "@/server/views";

/**
 * GET /api/v1/orders/{id}: one own order; someone else's is NOT_FOUND, like a missing one. The
 * delivery destination is the order's own copy, decrypted for the buyer only (PRD R5.2).
 */
export const GET = route({ auth: "session" }, async ({ session, params }) => {
  const id = pathId(params);
  const order = await myOrder(webPool(), { authSessionId: session.id, orderGroupId: id });
  if (order === null) throw new DomainError("NOT_FOUND", "Order not found.");
  const delivery = await myOrderDelivery(webPool(), { authSessionId: session.id, orderGroupId: id });
  return {
    json: {
      ...orderView(order),
      delivery:
        delivery === null ? null : orderDeliveryView(delivery, order.orderGroupId, session.actor.userId),
    },
  };
});
