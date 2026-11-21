import { createCheckoutSession, createCheckoutSessionFromCart } from "@delulu/db/runtime";
import { z } from "zod";
import { couponCodeSchema, speedBySellerSchema } from "@/server/cart";
import { SERVER_CONFIG } from "@/server/config";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { checkoutSessionView } from "@/server/views";

const explicitLines = z.strictObject({
  lines: z
    .array(z.strictObject({ productId: z.uuid() }))
    .min(1)
    .max(SERVER_CONFIG.http.maxCartLines),
  speedBySeller: speedBySellerSchema,
  couponCode: couponCodeSchema.optional(),
});

/** The server-side cart, all of it (LLD §8.4 `source: "CART"`). */
const fromCart = z.strictObject({
  source: z.literal("CART"),
  speedBySeller: speedBySellerSchema.optional(),
  couponCode: couponCodeSchema.optional(),
});

const body = z.union([explicitLines, fromCart]);

/**
 * POST /api/v1/checkout-sessions (Idempotency-Key): a priced, immutable quote valid for five
 * minutes, for explicit `lines` (buy now) or for the whole server-side cart (`source: "CART"`;
 * STANDARD for a seller not named; CART_CHANGED with the per-line issues when any line cannot be
 * bought). Every amount comes from price() in @delulu/core and is re-derived by the database.
 */
export const POST = route(
  { auth: "session", body, idempotencyKey: true },
  async ({ body: b, session, idempotencyKey }) => {
    const coupon = b.couponCode === undefined ? {} : { couponCode: b.couponCode };
    const result =
      "source" in b
        ? await createCheckoutSessionFromCart(payPool(), {
            authSessionId: session.id,
            ...(b.speedBySeller === undefined ? {} : { speedBySeller: b.speedBySeller }),
            ...coupon,
            idempotencyKey,
          })
        : await createCheckoutSession(payPool(), {
            authSessionId: session.id,
            lines: b.lines.map((l) => ({ productId: l.productId.toLowerCase() })),
            speedBySeller: b.speedBySeller,
            ...coupon,
            idempotencyKey,
          });
    return { status: 201, json: checkoutSessionView(result) };
  },
);
