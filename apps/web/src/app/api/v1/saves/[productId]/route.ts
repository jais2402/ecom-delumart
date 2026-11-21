import { unsaveProduct } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/** DELETE /api/v1/saves/{productId}: unsaves (not saved is a no-op). A completed passport step stays complete. */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.saveWriteActor }] },
  async ({ session, params }) => {
    const productId = pathId(params, "productId");
    await unsaveProduct(webPool(), { authSessionId: session.id, productId });
    return { json: { productId, saved: false } };
  },
);
