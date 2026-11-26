import { checkoutPaymentMethods } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { methodsView } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/payment-methods: the methods checkout offers the caller, in the configured order, with
 * whether each is available now and why not (switched off, or in maintenance until a time), and the limits.
 * Private: a response behind a session is never shared.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.paymentReadActor }] },
  async ({ session }) => ({
    json: methodsView(await checkoutPaymentMethods(webPool(), { authSessionId: session.id })),
  }),
);
