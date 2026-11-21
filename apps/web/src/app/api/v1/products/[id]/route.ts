import { DomainError } from "@delulu/core";
import { catalogProduct } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { productView } from "@/server/views";

/** GET /api/v1/products/{id}: one published product; public and cacheable; never reads the session. */
export const GET = route({ auth: "public" }, async ({ params }) => {
  const product = await catalogProduct(webPool(), pathId(params));
  if (product === null) throw new DomainError("NOT_FOUND", "Product not found.");
  return { json: productView(product) };
});
