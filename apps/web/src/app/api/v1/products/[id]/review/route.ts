import { requireValidReview } from "@delulu/core";
import { deleteReview, saveReview } from "@delulu/db/runtime";
import { trackAfter } from "@/server/analytics";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { ownReviewView, reviewBody } from "@/server/reviews";

/**
 * PUT /api/v1/products/{id}/review {rating, title?, body?}: the signed-in owner of the product
 * writes or edits their one review of it (decisions.md #14). The text is checked and screened here
 * (REVIEW_INVALID with details.reasons [{field, code}], never the text); the database re-checks the
 * shape, ownership (REVIEW_NOT_ALLOWED for a non-owner or the seller) and keeps every version.
 * Saving the same review again changes nothing, so a retry is safe without an idempotency key. A
 * change records a `review_submitted` analytics event (no props). Ten writes an hour per account.
 */
export const PUT = route(
  { auth: "session", body: reviewBody, rateLimits: [{ rule: RATE_RULES.reviewWriteActor }] },
  async ({ request, body, params, session }) => {
    const productId = pathId(params);
    const text = requireValidReview({ rating: body.rating, title: body.title, body: body.body });
    const saved = await saveReview(webPool(), { authSessionId: session.id, productId, ...text });
    if (saved.changed)
      trackAfter(request, "review_submitted", {}, { surface: "shop", authSessionId: session.id });
    return { json: { productId, changed: saved.changed, review: ownReviewView(saved) } };
  },
);

/**
 * DELETE /api/v1/products/{id}/review: deletes the actor's review for real (its text and every
 * version). A repeat answers the same; never having reviewed is REVIEW_NOT_FOUND.
 */
export const DELETE = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.reviewWriteActor }] },
  async ({ params, session }) => {
    const r = await deleteReview(webPool(), { authSessionId: session.id, productId: pathId(params) });
    return { json: { productId: r.productId, deleted: true } };
  },
);
