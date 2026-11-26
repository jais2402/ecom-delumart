import { adminActions } from "@delulu/db/runtime";
import { actionPageView, actionsQuery } from "@/server/admin-actions";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/actions?scope=OPEN|HISTORY|ALL&page=: the Super Admin's delayed actions with
 * their state and time left (Super Admin only; FORBIDDEN for anyone else). Names no user.
 */
export const GET = route(
  { auth: "session", query: actionsQuery, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session, query }) => {
    const page = await adminActions(webPool(), {
      authSessionId: session.id,
      scope: query.scope ?? "ALL",
      page: query.page,
    });
    return { json: actionPageView(page) };
  },
);
