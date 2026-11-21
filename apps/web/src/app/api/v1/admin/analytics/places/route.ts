import { analyticsPlaces } from "@delulu/db/runtime";
import { placesQuery, placesView } from "@/server/analytics-views";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/analytics/places?level=country|region|city&country&region&from&to: visitors,
 * sign-ups and purchases by place (PRD R7.1), from the suppressed rollup only: a place below the
 * minimum count was folded into "Other" before it was stored. "ZZ" is an unknown country, a null
 * region or city an unknown one. Super Admin only.
 */
export const GET = route(
  { auth: "session", query: placesQuery, rateLimits: [{ rule: RATE_RULES.analyticsReadActor }] },
  async ({ session, query }) => ({
    json: placesView(await analyticsPlaces(webPool(), { authSessionId: session.id, ...query })),
  }),
);
