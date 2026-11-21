import { analyticsOverview } from "@delulu/db/runtime";
import { overviewView, rangeQuery } from "@/server/analytics-views";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/analytics/overview?from&to: totals of the period and of the same-length period
 * before it — visitors (rolled-up traffic), sign-ups, orders, fictional spend (ledger), average
 * order value, creator unlocks, shops registered, listings published (the real tables). Super
 * Admin only (403 for anyone else, checked again by the database); `private, no-store`.
 */
export const GET = route(
  { auth: "session", query: rangeQuery, rateLimits: [{ rule: RATE_RULES.analyticsReadActor }] },
  async ({ session, query }) => ({
    json: overviewView(await analyticsOverview(webPool(), { authSessionId: session.id, ...query })),
  }),
);
