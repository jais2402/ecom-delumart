import { DomainError } from "@delulu/core";
import { setProductShipping } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { listingDetailView } from "@/server/views";

/** POST /api/v1/studio/products/{id}/shipping {offersExpress?, freeStandardDelivery?} */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({
      offersExpress: z.boolean().optional(),
      freeStandardDelivery: z.boolean().optional(),
    }),
    rateLimits: [{ rule: RATE_RULES.studioActor }],
  },
  async ({ body, params, session }) => {
    if (body.offersExpress === undefined && body.freeStandardDelivery === undefined) {
      throw new DomainError("VALIDATION_FAILED", "Send offersExpress or freeStandardDelivery.");
    }
    const product = await setProductShipping(webPool(), {
      authSessionId: session.id,
      productId: pathId(params),
      ...(body.offersExpress === undefined ? {} : { offersExpress: body.offersExpress }),
      ...(body.freeStandardDelivery === undefined ? {} : { freeStandardDelivery: body.freeStandardDelivery }),
    });
    return { json: { product: listingDetailView(product) } };
  },
);
