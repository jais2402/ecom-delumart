import { myProduct, reviseProduct } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { runJobsInlineInDevelopment } from "@/server/jobs";
import { RATE_RULES } from "@/server/rate-limit";
import { checkRevision, revisionBody } from "@/server/studio";
import { listingDetailView } from "@/server/views";

/**
 * POST /api/v1/studio/products/{id}/revise {name?, hook?, description?, altText?, templateId?}: a
 * new revision of a published listing's text, screened while the approved version stays live.
 */
export const POST = route(
  { auth: "session", body: revisionBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, params, session }) => {
    const productId = pathId(params);
    await reviseProduct(webPool(), { authSessionId: session.id, productId, revision: checkRevision(body) });
    await runJobsInlineInDevelopment();
    const product = await myProduct(webPool(), { authSessionId: session.id, productId });
    return { json: { product: listingDetailView(product) } };
  },
);
