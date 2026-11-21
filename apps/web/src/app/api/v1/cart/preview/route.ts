import { previewCart } from "@delulu/db/runtime";
import { z } from "zod";
import { couponCodeSchema, speedBySellerSchema } from "@/server/cart";
import { payPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { cartPreviewView } from "@/server/views";

const body = z.strictObject({
  speedBySeller: speedBySellerSchema.optional(),
  couponCode: couponCodeSchema.optional(),
});

/**
 * POST /api/v1/cart/preview {speedBySeller?, couponCode?}: the priced preview of the purchasable
 * lines for these options (STANDARD for a seller not named), through the same pricing path as
 * POST /checkout-sessions. A coupon that cannot be used gives the preview without it and a
 * `couponError` code; a speed a seller does not offer is DELIVERY_UNAVAILABLE.
 */
export const POST = route(
  {
    auth: "session",
    body,
    rateLimits: [{ rule: RATE_RULES.couponActor, when: (b) => b.couponCode !== undefined }],
  },
  async ({ body: b, session }) => {
    const preview = await previewCart(payPool(), {
      authSessionId: session.id,
      ...(b.speedBySeller === undefined ? {} : { speedBySeller: b.speedBySeller }),
      ...(b.couponCode === undefined ? {} : { couponCode: b.couponCode }),
    });
    return { json: cartPreviewView(preview) };
  },
);
