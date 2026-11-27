import { adminPaymentMethods, proposePaymentMethodChange } from "@delulu/db/runtime";
import { actionView } from "@/server/admin-actions";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { adminMethodsView, methodChangeBody } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/** GET /api/v1/admin/payment-methods: each method's current setting and any waiting change (Super Admin only). */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session }) => ({
    json: adminMethodsView(await adminPaymentMethods(webPool(), { authSessionId: session.id })),
  }),
);

/**
 * POST /api/v1/admin/payment-methods {method, enabled, displayOrder, limits, maintenance window, reason}:
 * proposes a change to one method. It joins the 24-hour delayed, cancellable queue (decisions.md #16):
 * nothing changes until it runs. Needs a recent sign-in. There is no faster path.
 */
export const POST = route(
  { auth: "session", body: methodChangeBody, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ body, session }) => {
    const { reason, ...change } = body;
    const action = await proposePaymentMethodChange(webPool(), {
      authSessionId: session.id,
      change,
      reason,
    });
    return { status: 201, json: { action: actionView(action as Parameters<typeof actionView>[0]) } };
  },
);
