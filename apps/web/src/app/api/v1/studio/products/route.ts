import { createDraft, myProducts } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { limitParam } from "@/server/query";
import { RATE_RULES } from "@/server/rate-limit";
import { checkDraft, draftBody } from "@/server/studio";
import { listingDetailView, listingView } from "@/server/views";

const query = z.object({
  status: z
    .enum(["DRAFT", "SCREENING", "NEEDS_REVIEW", "PUBLISHED", "REJECTED", "HIDDEN", "ARCHIVED"])
    .optional(),
  cursor: z.uuid().optional(),
  limit: limitParam,
});

/** GET /api/v1/studio/products?status=&cursor=&limit=: the owner's listings, newest first. */
export const GET = route({ auth: "session", query }, async ({ session, query: q }) => {
  const page = await myProducts(webPool(), {
    authSessionId: session.id,
    status: q.status ?? null,
    cursor: q.cursor?.toLowerCase() ?? null,
    ...(q.limit === undefined ? {} : { pageSize: q.limit }),
  });
  return { json: { items: page.items.map(listingView), nextCursor: page.nextCursor } };
});

/**
 * POST /api/v1/studio/products: a new draft (shape and lengths checked here and in the database;
 * the text is screened by the job after submission). DRAFT_LIMIT at 20 private drafts.
 */
export const POST = route(
  { auth: "session", body: draftBody, rateLimits: [{ rule: RATE_RULES.studioActor }] },
  async ({ body, session }) => {
    const product = await createDraft(webPool(), { authSessionId: session.id, draft: checkDraft(body) });
    return { status: 201, json: { product: listingDetailView(product) } };
  },
);
