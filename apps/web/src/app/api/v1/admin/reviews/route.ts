import { adminReviews } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";
import { adminReviewPageView } from "@/server/reviews";

const query = z.strictObject({
  filter: z.enum(["ALL", "HIDDEN"]).optional(),
  page: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v))),
});

/**
 * GET /api/v1/admin/reviews?filter=ALL|HIDDEN&page=: the newest reviews, with their moderation
 * state, for the console (Super Admin only; FORBIDDEN for anyone else). Names no user id.
 */
export const GET = route(
  { auth: "session", query, rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session, query: q }) => {
    const page = await adminReviews(webPool(), {
      authSessionId: session.id,
      filter: q.filter ?? "ALL",
      page: q.page,
    });
    return { json: adminReviewPageView(page) };
  },
);
