import { mySellerOrders } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { orderRefPageQuery } from "@/server/query";
import { RATE_RULES } from "@/server/rate-limit";
import { merchantOrderView } from "@/server/views";

/**
 * GET /api/v1/studio/orders?cursor=&limit=: the store's orders, newest first; buyers are anonymous.
 * Orders are named by their opaque reference (never a time-ordered id); the cursor is one. An order
 * is listed once the minute it was placed in has ended (0060); rate limited per account.
 */
export const GET = route(
  { auth: "session", query: orderRefPageQuery, rateLimits: [{ rule: RATE_RULES.studioReadActor }] },
  async ({ session, query: q }) => {
    const page = await mySellerOrders(webPool(), {
      authSessionId: session.id,
      cursor: q.cursor ?? null,
      ...(q.limit === undefined ? {} : { pageSize: q.limit }),
    });
    return { json: { items: page.items.map(merchantOrderView), nextCursor: page.nextCursor } };
  },
);
