import { deleteDraft, myProduct, updateDraft } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { checkDraftChanges, draftPatchBody } from "@/server/studio";
import { listingDetailView } from "@/server/views";

/** GET /api/v1/studio/products/{id}: one own listing with its revisions and price history. */
export const GET = route({ auth: "session" }, async ({ params, session }) => {
  const product = await myProduct(webPool(), { authSessionId: session.id, productId: pathId(params) });
  return { json: { product: listingDetailView(product) } };
});

/** PATCH /api/v1/studio/products/{id}: edits an unpublished draft (a new revision). */
export const PATCH = route(
  { auth: "session", body: draftPatchBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, params, session }) => {
    const product = await updateDraft(webPool(), {
      authSessionId: session.id,
      productId: pathId(params),
      changes: checkDraftChanges(body),
    });
    return { json: { product: listingDetailView(product) } };
  },
);

/** DELETE /api/v1/studio/products/{id}: deletes a draft that was never published. */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ params, session }) => {
    const productId = pathId(params);
    await deleteDraft(webPool(), { authSessionId: session.id, productId });
    return { json: { deleted: true, id: productId } };
  },
);
