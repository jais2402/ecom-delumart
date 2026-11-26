import { endSale, setSalePrice } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkPrice } from "@/server/studio";
import { listingDetailView } from "@/server/views";

/**
 * PUT /api/v1/studio/products/{id}/sale-price {salePriceRupees, requireReference?}: puts a live
 * listing on sale (R6.2). The previous price shows struck through only when it was the published
 * price for the required continuous hours; with `requireReference: true` the call is refused
 * (REFERENCE_PRICE_INELIGIBLE, nothing changes) when it would not. Owner only; the database
 * derives the company from the session.
 */
export const PUT = route(
  {
    auth: "session",
    body: z.strictObject({ salePriceRupees: z.number().int(), requireReference: z.boolean().optional() }),
    rateLimits: [{ rule: RATE_RULES.studioActor }],
  },
  async ({ body, params, session }) => {
    const product = await setSalePrice(webPool(), {
      authSessionId: session.id,
      productId: pathId(params),
      salePricePaise: checkPrice(body.salePriceRupees),
      requireReference: body.requireReference === true,
    });
    return { json: { product: listingDetailView(product) } };
  },
);

/** DELETE /api/v1/studio/products/{id}/sale-price: ends the sale; the list price is live again. */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ params, session }) => {
    const product = await endSale(webPool(), { authSessionId: session.id, productId: pathId(params) });
    return { json: { product: listingDetailView(product) } };
  },
);
