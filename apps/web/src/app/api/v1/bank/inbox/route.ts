import { myBankInbox } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { inboxView } from "@/server/payments";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/bank/inbox: the caller's own Delulu Bank inbox, newest first. The ONE response that
 * carries a one-time code (PRD R4.4), only while its message is open and only to the payer: private,
 * `no-store`, never in a log, an event or any other route. Nothing is sent by SMS, email or push.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.paymentReadActor }] },
  async ({ session }) => {
    const items = await myBankInbox(webPool(), { authSessionId: session.id });
    return { json: { items: items.map(inboxView) } };
  },
);
