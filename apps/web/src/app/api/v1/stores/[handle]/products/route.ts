import { DomainError } from "@delulu/core";
import { storeByHandle, storeProducts } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { uuidPageQuery } from "@/server/query";
import { productView } from "@/server/views";

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** GET /api/v1/stores/{handle}/products?cursor=&limit=: a store's published products; public and cacheable. */
export const GET = route({ auth: "public", query: uuidPageQuery }, async ({ params, query: q }) => {
  const handle = (params.handle ?? "").toLowerCase();
  if (handle.length > 24 || !HANDLE.test(handle)) throw new DomainError("NOT_FOUND", "Store not found.");
  if ((await storeByHandle(webPool(), handle)) === null)
    throw new DomainError("NOT_FOUND", "Store not found.");
  const page = await storeProducts(webPool(), {
    handle,
    cursor: q.cursor?.toLowerCase() ?? null,
    ...(q.limit === undefined ? {} : { pageSize: q.limit }),
  });
  return { json: { items: page.items.map(productView), nextCursor: page.nextCursor } };
});
