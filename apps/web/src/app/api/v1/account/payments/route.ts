import { myPayments } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { paymentRowView, paymentsQuery } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/account/payments?cursor=&limit=: the caller's own payment attempts, newest first: method,
 * status (Created, Authenticating, Authorised, Captured, Failed, Refunded), reference and, for a failed
 * one, the reason (which says no fictional money moved). Owner only; private, `no-store`.
 */
export const GET = route(
  { auth: "session", query: paymentsQuery, rateLimits: [{ rule: RATE_RULES.paymentReadActor }] },
  async ({ session, query }) => {
    const page = await myPayments(webPool(), {
      authSessionId: session.id,
      cursor: query.cursor ?? null,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { json: { items: page.items.map(paymentRowView), nextCursor: page.nextCursor } };
  },
);
