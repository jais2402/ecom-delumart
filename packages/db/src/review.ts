/**
 * Product ratings and reviews (docs/decisions.md #14) through the owner-run definer functions of
 * migration 0078. No application role reads or writes the review tables directly.
 *
 *  * Public reads (no session): productReviews, reviewSummaries. They name no user id, order,
 *    purchase time or review id, and show a review only once the minute of its purchase has ended.
 *  * The author's own (session): myReview, saveReview (create or edit; the same text again changes
 *    nothing, so a retry is safe), deleteReview (a retry after success answers deleted again).
 *  * The Super Admin (session): adminReviews, hideReview, restoreReview (audited).
 *
 * Ratings are small whole numbers, so counts and sums travel as JSON numbers; an average is the
 * integer `averageTenths` (4.3 is 43), never a float.
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { asWeb, isUuid, one, requireUuid } from "./command";

interface Session {
  authSessionId: string;
}

export interface ReviewSummary {
  productId: string;
  count: number;
  ratingSum: number;
  /** The average times ten, rounded half up (43 is 4.3); 0 with no reviews. */
  averageTenths: number;
}

export interface PublicReview {
  rating: number;
  title: string | null;
  body: string | null;
  /** The author's public handle, or null ("Verified owner"). */
  handle: string | null;
  /** The day it was written (YYYY-MM-DD, the store's reporting time zone). */
  createdOn: string;
  edited: boolean;
}

export interface ProductReviews extends ReviewSummary {
  /** Counts of 1, 2, 3, 4 and 5 stars, in that order. */
  distribution: [number, number, number, number, number];
  items: PublicReview[];
  page: number;
  pageSize: number;
  totalPages: number;
}

export type ReviewIneligibility = "NOT_OWNER" | "SELLER" | "UNAVAILABLE" | "ACCOUNT";

export interface OwnReview {
  rating: number;
  title: string | null;
  body: string | null;
  createdOn: string;
  edited: boolean;
  version: number;
  hidden: boolean;
  hiddenReason: string | null;
  /** Shown publicly now (false while hidden, or until the minute of the purchase has ended). */
  public: boolean;
}

export interface MyReview {
  productId: string;
  /** May write or edit a review of this product now. */
  eligible: boolean;
  reason: ReviewIneligibility | null;
  /** The handle the review is shown under, or null ("Verified owner"). */
  handle: string | null;
  review: OwnReview | null;
}

export interface SavedReview extends OwnReview {
  productId: string;
  /** False when the same review was saved again (a retry): no new version. */
  changed: boolean;
}

export interface AdminReview {
  reviewId: string;
  productId: string;
  productName: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  handle: string | null;
  createdOn: string;
  edited: boolean;
  hidden: boolean;
  hiddenReason: string | null;
  public: boolean;
}

export interface AdminReviewPage {
  items: AdminReview[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type AdminReviewFilter = "ALL" | "HIDDEN";

/** The most product ids one summaries call takes (`review_summary_max`). */
export const REVIEW_SUMMARY_MAX = 100;
/** The highest page number a list call takes. */
export const REVIEW_PAGE_MAX = 10_000;

function requirePage(page: number | undefined): number {
  const p = page ?? 1;
  if (!Number.isSafeInteger(p) || p < 1 || p > REVIEW_PAGE_MAX) {
    throw new DomainError("VALIDATION_FAILED", "page is a whole number from 1", { field: "page" });
  }
  return p;
}

/** One product's public reviews: summary, distribution and a page of the newest; null when it is not on sale. */
export function productReviews(
  pool: Pool,
  input: { productId: string; page?: number },
): Promise<ProductReviews | null> {
  const page = requirePage(input.page);
  if (!isUuid(input.productId)) return Promise.resolve(null);
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<{ r: ProductReviews | null }>("SELECT core.product_reviews($1, $2) AS r", [
      input.productId,
      page,
    ]);
    return rows[0]?.r ?? null;
  });
}

/** Rating summaries of published products (unknown or unpublished ids are left out). */
export async function reviewSummaries(pool: Pool, productIds: readonly string[]): Promise<ReviewSummary[]> {
  if (productIds.length > REVIEW_SUMMARY_MAX) {
    throw new DomainError("VALIDATION_FAILED", `at most ${REVIEW_SUMMARY_MAX} products`, {
      field: "productIds",
    });
  }
  for (const id of productIds) requireUuid(id, "productIds");
  if (productIds.length === 0) return [];
  return asWeb(pool, null, (c) =>
    one<ReviewSummary[]>(c, "SELECT core.product_review_summaries($1::uuid[]) AS r", [[...productIds]]),
  );
}

export function myReview(pool: Pool, input: Session & { productId: string }): Promise<MyReview> {
  if (!isUuid(input.productId)) throw new DomainError("NOT_FOUND", "product not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<MyReview>(c, "SELECT core.my_review($1) AS r", [input.productId]),
  );
}

/**
 * Creates or edits the actor's review of a product they own (a new version on a change). The web
 * server has already checked and screened the text (requireValidReview); the database checks the
 * shape again.
 */
export function saveReview(
  pool: Pool,
  input: Session & { productId: string; rating: number; title: string | null; body: string | null },
): Promise<SavedReview> {
  if (!isUuid(input.productId)) throw new DomainError("NOT_FOUND", "product not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<SavedReview>(c, "SELECT core.review_save($1, $2, $3, $4) AS r", [
      input.productId,
      input.rating,
      input.title,
      input.body,
    ]),
  );
}

/** Deletes the actor's review for real (its text and versions go); a repeat answers the same. */
export function deleteReview(
  pool: Pool,
  input: Session & { productId: string },
): Promise<{ productId: string; deleted: true; changed: boolean }> {
  if (!isUuid(input.productId)) throw new DomainError("REVIEW_NOT_FOUND", "review not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<{ productId: string; deleted: true; changed: boolean }>(c, "SELECT core.review_delete($1) AS r", [
      input.productId,
    ]),
  );
}

export function adminReviews(
  pool: Pool,
  input: Session & { filter?: AdminReviewFilter; page?: number },
): Promise<AdminReviewPage> {
  const page = requirePage(input.page);
  const filter = input.filter ?? "ALL";
  if (filter !== "ALL" && filter !== "HIDDEN") {
    throw new DomainError("VALIDATION_FAILED", "filter is ALL or HIDDEN", { field: "filter" });
  }
  return asWeb(pool, input.authSessionId, (c) =>
    one<AdminReviewPage>(c, "SELECT core.admin_reviews($1, $2) AS r", [filter, page]),
  );
}

export function hideReview(
  pool: Pool,
  input: Session & { reviewId: string; reason: string },
): Promise<{ reviewId: string; hidden: boolean }> {
  if (!isUuid(input.reviewId)) throw new DomainError("REVIEW_NOT_FOUND", "review not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<{ reviewId: string; hidden: boolean }>(c, "SELECT core.admin_review_hide($1, $2) AS r", [
      input.reviewId,
      input.reason,
    ]),
  );
}

export function restoreReview(
  pool: Pool,
  input: Session & { reviewId: string; reason: string },
): Promise<{ reviewId: string; hidden: boolean }> {
  if (!isUuid(input.reviewId)) throw new DomainError("REVIEW_NOT_FOUND", "review not found");
  return asWeb(pool, input.authSessionId, (c) =>
    one<{ reviewId: string; hidden: boolean }>(c, "SELECT core.admin_review_restore($1, $2) AS r", [
      input.reviewId,
      input.reason,
    ]),
  );
}
