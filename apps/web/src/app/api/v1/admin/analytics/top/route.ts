import { analyticsTop } from "@delulu/db/runtime";
import { topQuery, topView } from "@/server/analytics-views";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/analytics/top?kind=product|company|category&from&to&limit: the top products,
 * shops or categories by fictional spend, then orders, from the order lines of completed player
 * orders (shop name and handle, never an owner). Super Admin only.
 */
export const GET = route(
  { auth: "session", query: topQuery, rateLimits: [{ rule: RATE_RULES.analyticsReadActor }] },
  async ({ session, query }) => ({
    json: topView(await analyticsTop(webPool(), { authSessionId: session.id, ...query })),
  }),
);
