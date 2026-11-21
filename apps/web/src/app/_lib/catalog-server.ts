import { catalogProduct, catalogProducts } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { productView } from "@/server/views";
import type { ProductResponse } from "./api";

/**
 * Public catalog reads for server components: the same database functions the public
 * /api/v1/catalog and /api/v1/products routes use, with the same response shape. Public data only;
 * nothing here reads a session, so the pages that call it are the same for everyone.
 */
const PAGE = 50;

/**
 * `next build` runs with production settings and no database; pages are rendered per request, so
 * this guard only matters if the build ever evaluates one.
 */
const building = () => process.env.NEXT_PHASE === "phase-production-build";

export async function loadCatalog(category?: string): Promise<ProductResponse[]> {
  if (building()) return [];
  const all: ProductResponse[] = [];
  let cursor: string | null = null;
  do {
    const page = await catalogProducts(webPool(), { category: category ?? null, cursor, pageSize: PAGE });
    all.push(...page.items.map(productView));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

export async function loadProduct(id: string): Promise<ProductResponse | null> {
  const product = await catalogProduct(webPool(), id);
  return product === null ? null : productView(product);
}
