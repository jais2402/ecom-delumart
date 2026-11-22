import { setCheckoutDestination } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

const body = z.union([
  z.strictObject({ addressId: z.uuid() }),
  z.strictObject({ deliverTo: z.literal("FICTIONAL_SPOT") }),
]);

/**
 * PATCH /api/v1/checkout-sessions/{id} {addressId} | {deliverTo: "FICTIONAL_SPOT"}: where the open
 * session delivers. The database refuses an address that is not the caller's own
 * (ADDRESS_NOT_FOUND) and checks again inside the pay transaction. The address never changes the
 * price (PRD R5.2), so the quote stays as it is.
 */
export const PATCH = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.checkoutDestinationActor }] },
  async ({ body: b, session, params }) => {
    const r = await setCheckoutDestination(payPool(), {
      authSessionId: session.id,
      sessionId: pathId(params),
      destination:
        "addressId" in b
          ? { deliverTo: "ADDRESS", addressId: b.addressId.toLowerCase() }
          : { deliverTo: "FICTIONAL_SPOT" },
    });
    return { json: r };
  },
);
