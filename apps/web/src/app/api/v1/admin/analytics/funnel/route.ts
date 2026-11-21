import { analyticsFunnel } from "@delulu/db/runtime";
import { funnelView, rangeQuery } from "@/server/analytics-views";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/analytics/funnel?from&to: visitors → product views → cart adds → checkout
 * starts → purchases (visitors reaching each step, from the rollups) with step conversion.
 * Super Admin only.
 */
export const GET = route(
  { auth: "session", query: rangeQuery, rateLimits: [{ rule: RATE_RULES.analyticsReadActor }] },
  async ({ session, query }) => ({
    json: funnelView(await analyticsFunnel(webPool(), { authSessionId: session.id, ...query })),
  }),
);
