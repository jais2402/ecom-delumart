import { mySellerOrders } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { merchantOrderView } from "@/server/views";

/** GET /api/v1/studio/orders?cursor=&limit=: the store's orders, newest first; buyers are anonymous. */
export const GET = route({ auth: "session", query: uuidPageQuery }, async ({ session, query: q }) => {
  const page = await mySellerOrders(webPool(), {
    authSessionId: session.id,
    cursor: q.cursor?.toLowerCase() ?? null,
    ...(q.limit === undefined ? {} : { pageSize: q.limit }),
  });
  return { json: { items: page.items.map(merchantOrderView), nextCursor: page.nextCursor } };
});
