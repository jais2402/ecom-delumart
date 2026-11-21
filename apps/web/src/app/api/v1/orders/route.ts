import { myOrders } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { orderView } from "@/server/views";

/** GET /api/v1/orders?cursor=&limit=: own orders, newest first. */
export const GET = route({ auth: "session", query: uuidPageQuery }, async ({ session, query }) => {
  const page = await myOrders(webPool(), {
    authSessionId: session.id,
    cursor: query.cursor ?? null,
    ...(query.limit === undefined ? {} : { pageSize: query.limit }),
  });
  return { json: { items: page.items.map(orderView), nextCursor: page.nextCursor } };
});
