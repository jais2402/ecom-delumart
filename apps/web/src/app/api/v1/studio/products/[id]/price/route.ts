import { setProductPrice } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkPrice } from "@/server/studio";
import { listingDetailView } from "@/server/views";

/** POST /api/v1/studio/products/{id}/price {priceRupees}: a price-only change, live at once. */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ priceRupees: z.number().int() }),
    rateLimits: [{ rule: RATE_RULES.studioActor }],
  },
  async ({ body, params, session }) => {
    const product = await setProductPrice(webPool(), {
      authSessionId: session.id,
      productId: pathId(params),
      pricePaise: checkPrice(body.priceRupees),
    });
    return { json: { product: listingDetailView(product) } };
  },
);
