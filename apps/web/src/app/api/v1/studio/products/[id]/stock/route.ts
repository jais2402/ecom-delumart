import { allocateAndPublish, restockProduct, retireUnits } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkStockQuantity } from "@/server/studio";
import { listingDetailView } from "@/server/views";

/**
 * POST /api/v1/studio/products/{id}/stock {action, quantity?}:
 *  RESTOCK (quantity): more units of a published STANDARD_STOCKED listing (CAPACITY_EXCEEDED);
 *  RETIRE (quantity): retires available units (for an EXCLUSIVE edition this permanently lowers
 *    what can be sold: `sellableSupply` says how many can still ever sell);
 *  ALLOCATE_AND_PUBLISH (quantity optional): publishes an approved listing that waited for stock.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({
      action: z.enum(["RESTOCK", "RETIRE", "ALLOCATE_AND_PUBLISH"]),
      quantity: z.number().int().optional(),
    }),
    rateLimits: [{ rule: RATE_RULES.studioActor }],
  },
  async ({ body, params, session }) => {
    const productId = pathId(params);
    const input = { authSessionId: session.id, productId };
    if (body.action === "RESTOCK") {
      const quantity = checkStockQuantity(body.quantity, true) ?? 0;
      const product = await restockProduct(webPool(), { ...input, quantity });
      return { json: { product: listingDetailView(product) } };
    }
    if (body.action === "RETIRE") {
      const quantity = checkStockQuantity(body.quantity, true) ?? 0;
      const r = await retireUnits(webPool(), { ...input, quantity });
      return {
        json: { product: listingDetailView(r.product), retired: r.retired, sellableSupply: r.sellableSupply },
      };
    }
    const quantity = checkStockQuantity(body.quantity, false) ?? null;
    const product = await allocateAndPublish(webPool(), { ...input, quantity });
    return { json: { product: listingDetailView(product) } };
  },
);
