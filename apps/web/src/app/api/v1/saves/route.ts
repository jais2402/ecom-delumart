import { mySaves, saveProduct } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { RATE_RULES } from "@/server/rate-limit";
import { savedProductView } from "@/server/views";

/** GET /api/v1/saves?cursor=&limit=: the caller's saved products, newest first. */
export const GET = route({ auth: "session", query: uuidPageQuery }, async ({ session, query }) => {
  const page = await mySaves(webPool(), {
    authSessionId: session.id,
    cursor: query.cursor ?? null,
    ...(query.limit === undefined ? {} : { pageSize: query.limit }),
  });
  return { json: { items: page.items.map(savedProductView), nextCursor: page.nextCursor } };
});

/**
 * POST /api/v1/saves {productId}: saves a published product (already saved is a no-op). Refuses
 * PRODUCT_UNAVAILABLE, ONBOARDING_REQUIRED. Saving may complete the passport's saves step.
 */
export const POST = route(
  {
    auth: "session",
    body: z.strictObject({ productId: z.uuid() }),
    rateLimits: [{ rule: RATE_RULES.saveWriteActor }],
  },
  async ({ body, session }) => {
    const productId = body.productId.toLowerCase();
    await saveProduct(webPool(), { authSessionId: session.id, productId });
    return { json: { productId, saved: true } };
  },
);
