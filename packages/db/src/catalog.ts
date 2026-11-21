/**
 * The public catalog (migration 0026): published products with their current version, readable
 * by app_web without a signed-in session. Never drafts or any status but PUBLISHED. Public data
 * only: cacheable, and never combined with a private response.
 */
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import type { Page } from "./account";
import { asWeb, isUuid, requireUuid } from "./command";

export interface CatalogProduct {
  productId: string;
  name: string;
  hook: string | null;
  description: string;
  altText: string;
  pricePaise: bigint;
  category: string;
  templateId: number;
  /** The company's name, or "DeluluMart Originals" for platform seed stock. */
  sellerName: string | null;
  available: boolean;
  zap: boolean;
  /** 'SEED' for platform seed stock, else the selling company's id. */
  sellerKey: string;
  /** The store's handle (null for seed stock). */
  storeHandle: string | null;
  inventoryMode: "STANDARD_STOCKED" | "EXCLUSIVE" | "UNLIMITED_SEED";
  /** UNLIMITED (seed), IN_STOCK, LOW (a few left) or SOLD_OUT: a band, never an exact count. */
  stockBand: "UNLIMITED" | "IN_STOCK" | "LOW" | "SOLD_OUT";
  /** EXCLUSIVE editions: "#issued of supply". */
  edition: { issued: number; supply: number } | null;
}

interface Row {
  product_id: string;
  name: string;
  hook: string | null;
  description: string;
  alt_text: string;
  price_paise: string;
  category: string;
  template_id: number;
  seller_name: string | null;
  available: boolean;
  zap: boolean;
  seller_key: string;
  store_handle: string | null;
  inventory_mode: CatalogProduct["inventoryMode"];
  stock_band: CatalogProduct["stockBand"];
  edition_issued: number | null;
  edition_supply: number | null;
}

const COLUMNS = `product_id, name, hook, description, alt_text, price_paise::text AS price_paise, category,
                 template_id, seller_name, available, zap, seller_key, store_handle, inventory_mode, stock_band,
                 edition_issued, edition_supply`;

function productOf(r: Row): CatalogProduct {
  return {
    productId: r.product_id,
    name: r.name,
    hook: r.hook,
    description: r.description,
    altText: r.alt_text,
    pricePaise: BigInt(r.price_paise),
    category: r.category,
    templateId: r.template_id,
    sellerName: r.seller_name,
    available: r.available,
    zap: r.zap,
    sellerKey: r.seller_key,
    storeHandle: r.store_handle,
    inventoryMode: r.inventory_mode,
    stockBand: r.stock_band,
    edition:
      r.edition_supply === null ? null : { issued: Number(r.edition_issued ?? 0), supply: r.edition_supply },
  };
}

function checkPage(input: { cursor?: string | null; pageSize?: number }): void {
  if (input.cursor != null) requireUuid(input.cursor, "cursor");
  if (input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1)) {
    throw new DomainError("VALIDATION_FAILED", "page size is at least 1");
  }
}

/** Published products, optionally of one category, in product-id order (cursor: the last productId). */
export async function catalogProducts(
  pool: Pool,
  input: { category?: string | null; cursor?: string | null; pageSize?: number } = {},
): Promise<Page<CatalogProduct, string>> {
  checkPage(input);
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<Row & { max: number }>(
      `SELECT ${COLUMNS}, core.page_size($3) AS max FROM core.catalog_products($1, $2, $3)`,
      [input.category ?? null, input.cursor ?? null, input.pageSize ?? null],
    );
    const items = rows.map(productOf);
    const full = rows.length > 0 && rows.length === rows[0]?.max;
    return { items, nextCursor: full ? (items.at(-1)?.productId ?? null) : null };
  });
}

/** One published product, or null. */
export async function catalogProduct(pool: Pool, productId: string): Promise<CatalogProduct | null> {
  if (!isUuid(productId)) return null;
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<Row>(`SELECT ${COLUMNS} FROM core.catalog_product($1)`, [productId]);
    return rows[0] ? productOf(rows[0]) : null;
  });
}

/**
 * A product page: the published product, or UNAVAILABLE for a product that was published once and
 * is now hidden or archived (no text: owners' collections show a placeholder), or null.
 */
export type ProductPage = { status: "AVAILABLE"; product: CatalogProduct } | { status: "UNAVAILABLE"; productId: string };

export async function catalogProductPage(pool: Pool, productId: string): Promise<ProductPage | null> {
  if (!isUuid(productId)) return null;
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<Row>(`SELECT ${COLUMNS} FROM core.catalog_product($1)`, [productId]);
    if (rows[0]) return { status: "AVAILABLE", product: productOf(rows[0]) };
    const gone = await c.query<{ u: boolean }>("SELECT core.product_unavailable($1) AS u", [productId]);
    return gone.rows[0]?.u === true ? { status: "UNAVAILABLE", productId } : null;
  });
}

/** One store's published products in product-id order (cursor: the last productId). */
export async function storeProducts(
  pool: Pool,
  input: { handle: string; cursor?: string | null; pageSize?: number },
): Promise<Page<CatalogProduct, string>> {
  checkPage(input);
  return asWeb(pool, null, async (c) => {
    const { rows } = await c.query<Row & { max: number }>(
      `SELECT ${COLUMNS}, core.page_size($3) AS max FROM core.store_products($1, $2, $3)`,
      [input.handle, input.cursor ?? null, input.pageSize ?? null],
    );
    const items = rows.map(productOf);
    const full = rows.length > 0 && rows.length === rows[0]?.max;
    return { items, nextCursor: full ? (items.at(-1)?.productId ?? null) : null };
  });
}
