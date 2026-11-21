import { catalogProducts } from "@delulu/db/runtime";
import { z } from "zod";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { limitParam } from "@/server/query";
import { productView } from "@/server/views";

const query = z.object({
  category: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(64)
    .optional(),
  cursor: z.uuid().optional(),
  limit: limitParam,
});

/** GET /api/v1/catalog?category=&cursor=&limit=: public and cacheable; never reads the session. */
export const GET = route({ auth: "public", query }, async ({ query: q }) => {
  const page = await catalogProducts(webPool(), {
    category: q.category ?? null,
    cursor: q.cursor ?? null,
    ...(q.limit === undefined ? {} : { pageSize: q.limit }),
  });
  return { json: { items: page.items.map(productView), nextCursor: page.nextCursor } };
});
