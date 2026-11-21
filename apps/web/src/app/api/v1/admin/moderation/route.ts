import { moderationQueue } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { RATE_RULES } from "@/server/rate-limit";
import { appealQueueItemView, moderationItemView } from "@/server/views";

/**
 * GET /api/v1/admin/moderation?cursor=&limit=: listings held for review, oldest first, then the open
 * appeals with the original decision and its evidence (Super Admin only).
 */
export const GET = route(
  { auth: "session", query: uuidPageQuery, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session, query: q }) => {
    const page = await moderationQueue(webPool(), {
      authSessionId: session.id,
      cursor: q.cursor?.toLowerCase() ?? null,
      ...(q.limit === undefined ? {} : { pageSize: q.limit }),
    });
    return {
      json: {
        items: page.items.map(moderationItemView),
        nextCursor: page.nextCursor,
        appeals: page.appeals.map(appealQueueItemView),
      },
    };
  },
);
