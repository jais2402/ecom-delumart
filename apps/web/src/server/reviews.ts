import "./server-only";
import type { AdminReviewPage, MyReview, OwnReview, ProductReviews, ReviewSummary } from "@delulu/db/runtime";
import { z } from "zod";

/**
 * Ratings and reviews (docs/decisions.md #14): request schemas and the response shapes. Each view
 * copies named fields only, so nothing the database adds later reaches a response by accident.
 * Public views carry no user id, order, review id or time finer than a day; the author's own view
 * is served only by private (session, no-store) routes.
 */

/** PUT body: the text is checked and screened by requireValidReview (REVIEW_INVALID with reasons). */
export const reviewBody = z.strictObject({
  rating: z.number().nullable().optional(),
  title: z.string().max(4_000).nullable().optional(),
  body: z.string().max(8_000).nullable().optional(),
});

export const reviewPageQuery = z.strictObject({
  page: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v))),
});

export function summaryView(s: ReviewSummary) {
  return { productId: s.productId, count: s.count, ratingSum: s.ratingSum, averageTenths: s.averageTenths };
}

export function productReviewsView(r: ProductReviews) {
  return {
    ...summaryView(r),
    distribution: [...r.distribution],
    items: r.items.map((i) => ({
      rating: i.rating,
      title: i.title,
      body: i.body,
      author: i.handle === null ? null : { handle: i.handle },
      createdOn: i.createdOn,
      edited: i.edited,
      verifiedOwner: true as const,
    })),
    page: r.page,
    pageSize: r.pageSize,
    totalPages: r.totalPages,
  };
}

export function ownReviewView(r: OwnReview) {
  return {
    rating: r.rating,
    title: r.title,
    body: r.body,
    createdOn: r.createdOn,
    edited: r.edited,
    hidden: r.hidden,
    hiddenReason: r.hiddenReason,
    public: r.public,
  };
}

export function myReviewView(m: MyReview) {
  return {
    productId: m.productId,
    eligible: m.eligible,
    reason: m.reason,
    handle: m.handle,
    review: m.review === null ? null : ownReviewView(m.review),
  };
}

export function adminReviewPageView(p: AdminReviewPage) {
  return {
    items: p.items.map((i) => ({
      reviewId: i.reviewId,
      productId: i.productId,
      productName: i.productName,
      rating: i.rating,
      title: i.title,
      body: i.body,
      handle: i.handle,
      createdOn: i.createdOn,
      edited: i.edited,
      hidden: i.hidden,
      hiddenReason: i.hiddenReason,
      public: i.public,
    })),
    page: p.page,
    pageSize: p.pageSize,
    total: p.total,
    totalPages: p.totalPages,
  };
}
