import { adminConfigOverview, proposeConfigChange } from "@delulu/db/runtime";
import { actionView, configChangeBody, configOverviewView } from "@/server/admin-actions";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/config: the allow-listed configuration keys with the value orders are placed
 * under now, the default, the bounds and any change waiting for its delay (Super Admin only).
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session }) => {
    const overview = await adminConfigOverview(webPool(), { authSessionId: session.id });
    return { json: configOverviewView(overview) };
  },
);

/**
 * POST /api/v1/admin/config {key, value, reason}: proposes changing one allow-listed configuration
 * value. It is queued for the configured delay (24 hours), announced by outbox record, and can be
 * cancelled until it runs; it applies only to orders placed afterwards. Needs a sign-in within the
 * last five minutes (401 REAUTH_REQUIRED). Money values are whole paise written as a string.
 */
export const POST = route(
  {
    auth: "session",
    body: configChangeBody,
    rateLimits: [{ rule: RATE_RULES.adminActor }, { rule: RATE_RULES.adminProposeActor }],
  },
  async ({ body, session }) => {
    const action = await proposeConfigChange(webPool(), {
      authSessionId: session.id,
      key: body.key,
      value: body.value,
      reason: body.reason,
    });
    return { status: 201, json: { action: actionView(action) } };
  },
);
