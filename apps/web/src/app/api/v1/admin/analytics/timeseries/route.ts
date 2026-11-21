import { analyticsTimeseries } from "@delulu/db/runtime";
import { timeseriesQuery, timeseriesView } from "@/server/analytics-views";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/analytics/timeseries?metric&from&to: one point per UTC day. Traffic metrics
 * (visitors, page_views, searches, product_views, cart_adds, checkout_starts) come from the
 * rollups and are null on a day not rolled up; record metrics (sign_ups, orders, spend,
 * creator_unlocks, shops_registered, listings_published) from the real tables. Super Admin only.
 */
export const GET = route(
  { auth: "session", query: timeseriesQuery, rateLimits: [{ rule: RATE_RULES.analyticsReadActor }] },
  async ({ session, query }) => ({
    json: timeseriesView(await analyticsTimeseries(webPool(), { authSessionId: session.id, ...query })),
  }),
);
