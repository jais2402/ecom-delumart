import { DomainError } from "@delulu/core";
import { catalogProductPage } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { pathId, route } from "@/server/http";
import { productView } from "@/server/views";

/**
 * GET /api/v1/products/{id}: one published product ({status: "AVAILABLE", ...product}), or, for a
 * product that was published once and is now hidden or archived, {id, status: "UNAVAILABLE"} with
 * no text (owners' collections show a placeholder). Anything else is 404. Public and cacheable;
 * never reads the session.
 */
export const GET = route({ auth: "public" }, async ({ params }) => {
  const page = await catalogProductPage(webPool(), pathId(params));
  if (page === null) throw new DomainError("NOT_FOUND", "Product not found.");
  if (page.status === "UNAVAILABLE") return { json: { id: page.productId, status: "UNAVAILABLE" } };
  return { json: { ...productView(page.product), status: "AVAILABLE" } };
});
