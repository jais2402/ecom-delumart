import { catalogProduct, catalogProducts } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { productView } from "@/server/views";
import type { ProductResponse } from "./api";

/**
 * Public catalog reads for server components: the same database functions the public
 * /api/v1/catalog and /api/v1/products routes use, with the same response shape. Public data only;
 * nothing here reads a session, so the pages that call it stay static and cacheable.
 */
const PAGE = 50;

/**
 * `next build` runs with production settings and no database, so the static pages are generated
 * empty at build time; the browser then fills them from the public catalog route (usePublicCatalog)
 * until the first background revalidation produces the full page.
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
