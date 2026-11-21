/**
 * Seed catalog loader. Run with a pool logged in as the database OWNER (the migration role):
 * it writes categories, platform seed products (seller SEED, UNLIMITED_SEED stock, PUBLISHED)
 * and their immutable versions directly, which no application role may do.
 *
 * Idempotent: product ids are derived from the string id (UUID version 5 in a fixed namespace),
 * so re-running changes nothing unless a product's content changed, in which case it gets one
 * new revision (versions are immutable) and its current version moves to it. A product an
 * administrator has hidden stays hidden.
 */
import { createHash } from "node:crypto";
import { DomainError } from "@delulu/core";
import type { Pool } from "pg";
import { withTransaction } from "./transaction";

/** The shape of apps/web/src/data/seed-catalog.ts SeedProduct (passed in, never imported). */
export interface SeedProductInput {
  /** kebab-case, unique, e.g. "monsoon-in-a-jar" */
  id: string;
  name: string;
  hook: string;
  description: string;
  altText: string;
  /** category slug */
  category: string;
  /** whole rupees, 100 to 1,000,000,000 */
  priceRupees: number;
  /** integer 0–359: stored as the product version's template id */
  templateHue: number;
  zapEligible: boolean;
}

export interface SeedCategoryInput {
  slug: string;
  name: string;
  blurb: string;
}

export interface SeedResult {
  categories: number;
  productsCreated: number;
  versionsCreated: number;
}

/** Fixed namespace for seed product ids. Never change it: ids are referenced by orders. */
export const SEED_PRODUCT_NAMESPACE = "6d1f3c52-8a4e-5b7f-9c20-d3e1a0b4c5f6";

/** RFC 9562 UUID version 5 (SHA-1, name-based). */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The database id of a seed product's string id. */
export function seedProductId(id: string): string {
  return uuidv5(`product:${id}`, SEED_PRODUCT_NAMESPACE);
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function invalid(message: string, id: string): never {
  throw new DomainError("VALIDATION_FAILED", message, { id });
}

function lengthWithin(value: unknown, min: number, max: number): boolean {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validate(p: SeedProductInput): bigint {
  if (!SLUG.test(p.id)) invalid("seed product id must be kebab-case", p.id);
  if (!lengthWithin(p.name, 3, 80)) invalid("name must be 3–80 characters", p.id);
  if (!lengthWithin(p.hook, 1, 140)) invalid("hook must be 1–140 characters", p.id);
  if (!lengthWithin(p.description, 20, 400)) invalid("description must be 20–400 characters", p.id);
  if (!lengthWithin(p.altText, 1, 200)) invalid("alt text must be 1–200 characters", p.id);
  if (!SLUG.test(p.category)) invalid("category must be a slug", p.id);
  if (!Number.isSafeInteger(p.priceRupees) || p.priceRupees < 100 || p.priceRupees > 1_000_000_000) {
    invalid("price must be whole rupees between 100 and 1,000,000,000", p.id);
  }
  if (!Number.isSafeInteger(p.templateHue) || p.templateHue < 0 || p.templateHue > 359) {
    invalid("template hue must be an integer 0–359", p.id);
  }
  if (typeof p.zapEligible !== "boolean") invalid("zapEligible must be a boolean", p.id);
  return BigInt(p.priceRupees) * 100n; // whole rupees to paise, exact
}

function titleOf(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Upserts the categories (and any category a product names that is not given, titled from its
 * slug) and the seed products with one version each, in one transaction.
 */
export async function seedCatalog(
  pool: Pool,
  products: readonly SeedProductInput[],
  categories: readonly SeedCategoryInput[] = [],
): Promise<SeedResult> {
  const prices = new Map<string, bigint>();
  for (const p of products) {
    if (prices.has(p.id)) invalid("seed product ids must be unique", p.id);
    prices.set(p.id, validate(p));
  }
  for (const c of categories) {
    if (!SLUG.test(c.slug) || !lengthWithin(c.name, 1, 80) || !lengthWithin(c.blurb, 0, 300)) {
      invalid("category must have a slug, a 1–80 character name and a blurb of up to 300", c.slug);
    }
  }
  const named = new Map(categories.map((c) => [c.slug, c]));
  for (const p of products) {
    if (!named.has(p.category))
      named.set(p.category, { slug: p.category, name: titleOf(p.category), blurb: "" });
  }

  return withTransaction(pool, async (c) => {
    for (const cat of named.values()) {
      const given = categories.some((x) => x.slug === cat.slug);
      await c.query(
        given
          ? `INSERT INTO core.category (slug, name, blurb) VALUES ($1, $2, $3)
             ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, blurb = EXCLUDED.blurb`
          : "INSERT INTO core.category (slug, name, blurb) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING",
        [cat.slug, cat.name, cat.blurb],
      );
    }
    let productsCreated = 0;
    let versionsCreated = 0;
    for (const p of products) {
      const id = seedProductId(p.id);
      const price = prices.get(p.id) ?? 0n;
      const inserted = await c.query(
        `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, zap_flag, published_at)
         VALUES ($1, NULL, 'SEED', 'PUBLISHED', $2, 'UNLIMITED_SEED', $3, now())
         ON CONFLICT (id) DO NOTHING`,
        [id, p.category, p.zapEligible],
      );
      productsCreated += inserted.rowCount ?? 0;
      const existing = await c.query<{ seller_type: string }>(
        "SELECT seller_type FROM core.product WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (existing.rows[0]?.seller_type !== "SEED") invalid("a non-seed product holds this id", p.id);
      await c.query("UPDATE core.product SET category = $2, zap_flag = $3 WHERE id = $1", [
        id,
        p.category,
        p.zapEligible,
      ]);
      const same = await c.query(
        `SELECT 1 FROM core.product pr JOIN core.product_version v ON v.id = pr.current_version_id
          WHERE pr.id = $1 AND v.name = $2 AND v.hook IS NOT DISTINCT FROM $3 AND v.description = $4
            AND v.alt_text = $5 AND v.template_id = $6 AND v.price_paise = $7`,
        [id, p.name, p.hook, p.description, p.altText, p.templateHue, price.toString()],
      );
      if ((same.rowCount ?? 0) > 0) continue;
      const { rows } = await c.query<{ revision: number }>(
        "SELECT COALESCE(max(revision), 0) + 1 AS revision FROM core.product_version WHERE product_id = $1",
        [id],
      );
      const revision = rows[0]?.revision ?? 1;
      const versionId = uuidv5(`product:${p.id}#${revision}`, SEED_PRODUCT_NAMESPACE);
      await c.query(
        `INSERT INTO core.product_version (id, product_id, revision, name, hook, description, alt_text, template_id,
                                           price_paise, search)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 to_tsvector('simple', $4 || ' ' || $5 || ' ' || $6))`,
        [versionId, id, revision, p.name, p.hook, p.description, p.altText, p.templateHue, price.toString()],
      );
      await c.query("UPDATE core.product SET current_version_id = $2 WHERE id = $1", [id, versionId]);
      versionsCreated += 1;
    }
    return { categories: named.size, productsCreated, versionsCreated };
  });
}
