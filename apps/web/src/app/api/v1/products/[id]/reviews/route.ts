import { DomainError } from "@delulu/core";
import { productReviews } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { productReviewsView, reviewPageQuery } from "@/server/reviews";

/**
 * GET /api/v1/products/{id}/reviews?page=: a published product's ratings and reviews (decisions.md
 * #14): count, rating sum, averageTenths (43 is 4.3), the 1-5 star distribution and a page of the
 * newest reviews (rating, title, body, the author's public handle or none, "verified owner", the
 * day). Public and cacheable; never reads the session, so it never carries "your review" (that is
 * GET /api/v1/me/reviews/{productId}). A product not on sale is 404.
 */
export const GET = route({ auth: "public", query: reviewPageQuery }, async ({ params, query }) => {
  const r = await productReviews(webPool(), { productId: pathId(params), page: query.page });
  if (r === null) throw new DomainError("NOT_FOUND", "Product not found.");
  return { json: productReviewsView(r) };
});
