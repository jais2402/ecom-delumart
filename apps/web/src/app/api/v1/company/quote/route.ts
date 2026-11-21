import { companyQuote } from "@delulu/db/runtime";
import { z } from "zod";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkStoreIdentity } from "@/server/selling";
import { companyQuoteView } from "@/server/views";

const body = z.strictObject({
  handle: z.string().max(64),
  displayName: z.string().max(200),
  description: z.string().max(2000).default(""),
});

/**
 * POST /api/v1/company/quote {handle, displayName, description}: checked and screened here
 * (VALIDATION_FAILED with `details.reasons` per field), then a COMPANY_REGISTRATION checkout session
 * that reserves the handle for five minutes. Pay it with POST /checkout-sessions/{id}/attempts
 * (and /attempts/{id}/pin for a card), then POST /company/register.
 */
export const POST = route(
  { auth: "session", body, rateLimits: [{ rule: RATE_RULES.companyActor }] },
  async ({ body: b, session }) => {
    const identity = checkStoreIdentity(b);
    const quote = await companyQuote(payPool(), { authSessionId: session.id, ...identity });
    return { status: 201, json: companyQuoteView(quote) };
  },
);
