import { REVIEW_SUMMARY_MAX, reviewSummaries } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { summaryView } from "@/server/reviews";

const query = z.strictObject({
  productIds: z
    .string()
    .max(REVIEW_SUMMARY_MAX * 37)
    .transform((v) => [...new Set(v.split(",").filter((s) => s !== ""))].map((s) => s.toLowerCase()))
    .pipe(z.array(z.uuid()).min(1).max(REVIEW_SUMMARY_MAX)),
});

/**
 * GET /api/v1/review-summaries?productIds=a,b: rating summaries (count, rating sum, averageTenths)
 * for up to 100 products, for cards and rails. Published products only; others are left out.
 * Public and cacheable; never reads the session.
 */
export const GET = route({ auth: "public", query }, async ({ query: q }) => {
  const items = await reviewSummaries(webPool(), q.productIds);
  return { json: { items: items.map(summaryView) } };
});
