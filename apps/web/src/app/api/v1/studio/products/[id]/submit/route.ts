import { myProduct, submitProduct } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { runJobsInlineInDevelopment } from "@/server/jobs";
import { RATE_RULES } from "@/server/rate-limit";
import { listingDetailView } from "@/server/views";

/**
 * POST /api/v1/studio/products/{id}/submit: DRAFT -> SCREENING, pinning the current revision.
 * PUBLISH_LIMIT, SUBMISSION_LIMIT. In development only, the jobs run once after the submission has
 * committed (so the listing is screened without a scheduler); never in production.
 */
export const POST = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ params, session }) => {
    const productId = pathId(params);
    let product = await submitProduct(webPool(), { authSessionId: session.id, productId });
    await runJobsInlineInDevelopment();
    if (product.status === "SCREENING")
      product = await myProduct(webPool(), { authSessionId: session.id, productId });
    return { json: { product: listingDetailView(product) } };
  },
);
