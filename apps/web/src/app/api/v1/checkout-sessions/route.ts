import { createCheckoutSession } from "@delulu/db/runtime";
import { z } from "zod";
import { SERVER_CONFIG } from "@/server/config";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { checkoutSessionView } from "@/server/views";

const body = z.strictObject({
  lines: z
    .array(z.strictObject({ productId: z.uuid() }))
    .min(1)
    .max(SERVER_CONFIG.http.maxCartLines),
  speedBySeller: z.record(z.string().min(1).max(64), z.enum(["STANDARD", "EXPRESS", "ZAP"])),
  couponCode: z.string().min(1).max(64).optional(),
});

/**
 * POST /api/v1/checkout-sessions (Idempotency-Key): a priced, immutable quote valid for five
 * minutes. Every amount comes from price() in @delulu/core and is re-derived by the database.
 */
export const POST = route(
  { auth: "session", body, idempotencyKey: true },
  async ({ body: b, session, idempotencyKey }) => {
    const result = await createCheckoutSession(payPool(), {
      authSessionId: session.id,
      lines: b.lines.map((l) => ({ productId: l.productId.toLowerCase() })),
      speedBySeller: b.speedBySeller,
      ...(b.couponCode === undefined ? {} : { couponCode: b.couponCode }),
      idempotencyKey,
    });
    return { status: 201, json: checkoutSessionView(result) };
  },
);
