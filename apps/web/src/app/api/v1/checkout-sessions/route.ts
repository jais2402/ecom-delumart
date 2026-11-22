import { createCheckoutSession, createCheckoutSessionFromCart } from "@delulu/db/runtime";
import { z } from "zod";
import { couponCodeSchema, speedBySellerSchema } from "@/server/cart";
import { SERVER_CONFIG } from "@/server/config";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkoutSessionView } from "@/server/views";

/** Where to deliver: one of the caller's own addresses, or the fictional spot (the default). */
const destination = {
  addressId: z.uuid().optional(),
  deliverTo: z.literal("FICTIONAL_SPOT").optional(),
};

const explicitLines = z.strictObject({
  lines: z
    .array(z.strictObject({ productId: z.uuid() }))
    .min(1)
    .max(SERVER_CONFIG.http.maxCartLines),
  speedBySeller: speedBySellerSchema,
  couponCode: couponCodeSchema.optional(),
  ...destination,
});

/** The server-side cart, all of it (LLD §8.4 `source: "CART"`). */
const fromCart = z.strictObject({
  source: z.literal("CART"),
  speedBySeller: speedBySellerSchema.optional(),
  couponCode: couponCodeSchema.optional(),
  ...destination,
});

const body = z
  .union([explicitLines, fromCart])
  .refine((b) => b.addressId === undefined || b.deliverTo === undefined, { path: ["deliverTo"] });

/**
 * POST /api/v1/checkout-sessions (Idempotency-Key): a priced, immutable quote valid for five
 * minutes, for explicit `lines` (buy now) or for the whole server-side cart (`source: "CART"`;
 * STANDARD for a seller not named; CART_CHANGED with the per-line issues when any line cannot be
 * bought). Every amount comes from price() in @delulu/core and is re-derived by the database.
 * `addressId` names one of the caller's own saved addresses (ADDRESS_NOT_FOUND otherwise); without
 * it, or with `deliverTo: "FICTIONAL_SPOT"`, the order goes to the fictional delivery spot
 * (decisions.md #4). The destination never changes the price (PRD R5.2).
 */
export const POST = route(
  {
    auth: "session",
    body,
    idempotencyKey: true,
    rateLimits: [
      { rule: RATE_RULES.checkoutActor },
      { rule: RATE_RULES.couponActor, when: (b) => b.couponCode !== undefined },
    ],
  },
  async ({ body: b, session, idempotencyKey }) => {
    const coupon = b.couponCode === undefined ? {} : { couponCode: b.couponCode };
    const address = b.addressId === undefined ? {} : { addressId: b.addressId.toLowerCase() };
    const result =
      "source" in b
        ? await createCheckoutSessionFromCart(payPool(), {
            authSessionId: session.id,
            ...(b.speedBySeller === undefined ? {} : { speedBySeller: b.speedBySeller }),
            ...coupon,
            ...address,
            idempotencyKey,
          })
        : await createCheckoutSession(payPool(), {
            authSessionId: session.id,
            lines: b.lines.map((l) => ({ productId: l.productId.toLowerCase() })),
            speedBySeller: b.speedBySeller,
            ...coupon,
            ...address,
            idempotencyKey,
          });
    return { status: 201, json: checkoutSessionView(result) };
  },
);
