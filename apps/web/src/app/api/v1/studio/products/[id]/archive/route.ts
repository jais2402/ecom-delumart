import { archiveProduct } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { listingDetailView } from "@/server/views";

/** POST /api/v1/studio/products/{id}/archive: PUBLISHED -> ARCHIVED; its remaining units are retired. */
export const POST = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ params, session }) => {
    const product = await archiveProduct(webPool(), { authSessionId: session.id, productId: pathId(params) });
    return { json: { product: listingDetailView(product) } };
  },
);
