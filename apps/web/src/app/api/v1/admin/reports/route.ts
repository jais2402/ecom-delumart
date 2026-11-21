import { adminReports } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { RATE_RULES } from "@/server/rate-limit";
import { reportCaseView } from "@/server/views";

/** GET /api/v1/admin/reports?cursor=&limit=: open report cases, oldest first (Super Admin only). */
export const GET = route(
  { auth: "session", query: uuidPageQuery, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session, query: q }) => {
    const page = await adminReports(webPool(), {
      authSessionId: session.id,
      cursor: q.cursor?.toLowerCase() ?? null,
      ...(q.limit === undefined ? {} : { pageSize: q.limit }),
    });
    return { json: { items: page.items.map(reportCaseView), nextCursor: page.nextCursor } };
  },
);
