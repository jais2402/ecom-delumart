import { registerCompany } from "@delulu/db/runtime";
import { z } from "zod";
import { track } from "@/server/analytics";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { companyReceiptView } from "@/server/views";

/**
 * POST /api/v1/company/register {sessionId, attemptId} (Idempotency-Key): the registration's pay
 * transaction. Repeating it with the same key returns the same company; at most one company and
 * one charge per person. A refusal creates no company and takes no money. A new company records a
 * `shop_registered` analytics event.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ sessionId: z.uuid(), attemptId: z.uuid() }),
    idempotencyKey: true,
    rateLimits: [{ rule: RATE_RULES.companyActor }],
  },
  async ({ request, body, session, idempotencyKey }) => {
    const receipt = await registerCompany(payPool(), {
      authSessionId: session.id,
      sessionId: body.sessionId.toLowerCase(),
      attemptId: body.attemptId.toLowerCase(),
      idempotencyKey,
    });
    if (!receipt.replayed) {
      await track(
        request,
        "shop_registered",
        { company_id: receipt.companyId.toLowerCase() },
        { surface: "studio", authSessionId: session.id },
      );
    }
    return { status: receipt.replayed ? 200 : 201, json: companyReceiptView(receipt) };
  },
);
