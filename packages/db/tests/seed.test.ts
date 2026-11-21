import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogProduct, catalogProducts } from "../src/catalog";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import {
  type SeedCategoryInput,
  type SeedProductInput,
  seedCatalog,
  seedProductId,
  uuidv5,
} from "../src/seed";
import { codeOf, key, user } from "./checkout-fixtures";
import { countRows, createTestDatabase, stateOf, type TestDatabase } from "./helpers";

const CATEGORIES: SeedCategoryInput[] = [
  { slug: "impossible-tech", name: "Impossible Tech", blurb: "Gadgets that bend the laws of physics." },
  { slug: "food-fantasies", name: "Food Fantasies", blurb: "Snacks from an imaginary kitchen." },
];

const PRODUCTS: SeedProductInput[] = [
  {
    id: "teleporting-tiffin-box",
    name: "Teleporting Tiffin Box",
    hook: "Your lunch arrives at your desk the moment you start feeling hungry.",
    description: "A steel lunch box with a tiny built-in door to elsewhere. Pack it once; it turns up warm.",
    altText: "Studio photo of a steel tiffin box with a tiny brass door.",
    category: "impossible-tech",
    priceRupees: 2999,
    templateHue: 12,
    zapEligible: true,
  },
  {
    id: "monsoon-in-a-jar",
    name: "Monsoon in a Jar",
    hook: "The first rain of the season, on demand.",
    description: "Open the lid and the room smells of wet earth and chai. Closes politely when asked.",
    altText: "A glass jar with a tiny raincloud inside.",
    category: "food-fantasies",
    priceRupees: 1_000_000_000,
    templateHue: 200,
    zapEligible: false,
  },
  {
    id: "pocket-sunset",
    name: "Pocket Sunset",
    hook: "A sunset that fits in your shirt pocket.",
    description: "Unfold it on any evening and the sky obliges. Batteries not included or needed.",
    altText: "An orange glow spilling out of a folded handkerchief.",
    category: "cosmic-collectibles",
    priceRupees: 100,
    templateHue: 30,
    zapEligible: false,
  },
];

describe("seed catalog loader", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
  });
  afterAll(async () => {
    await db.drop();
  });

  it("product ids are deterministic UUID v5 values derived from the string id", () => {
    const id = seedProductId("monsoon-in-a-jar");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedProductId("monsoon-in-a-jar")).toBe(id);
    expect(seedProductId("pocket-sunset")).not.toBe(id);
    // RFC 9562 test vector: v5("www.example.com", DNS namespace)
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("upserts categories and PUBLISHED, UNLIMITED_SEED seed products with one version each; re-running is idempotent", async () => {
    const first = await seedCatalog(pool, PRODUCTS, CATEGORIES);
    expect(first).toEqual({ categories: 3, productsCreated: 3, versionsCreated: 1 * 3 });
    const again = await seedCatalog(pool, PRODUCTS, CATEGORIES);
    expect(again).toEqual({ categories: 3, productsCreated: 0, versionsCreated: 0 });

    const ids = PRODUCTS.map((p) => seedProductId(p.id));
    const { rows } = await pool.query<{
      id: string;
      seller_type: string;
      company_id: string | null;
      status: string;
      inventory_mode: string;
      zap_flag: boolean;
      versions: string;
    }>(
      `SELECT p.id, p.seller_type, p.company_id, p.status, p.inventory_mode, p.zap_flag,
              (SELECT count(*) FROM core.product_version v WHERE v.product_id = p.id) AS versions
         FROM core.product p WHERE p.id = ANY($1) ORDER BY p.id`,
      [ids],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        seller_type: "SEED",
        company_id: null,
        status: "PUBLISHED",
        inventory_mode: "UNLIMITED_SEED",
        versions: "1",
      });
    }
    const cats = await pool.query<{ slug: string; name: string }>(
      "SELECT slug, name FROM core.category ORDER BY slug",
    );
    expect(cats.rows).toEqual([
      { slug: "cosmic-collectibles", name: "Cosmic Collectibles" },
      { slug: "food-fantasies", name: "Food Fantasies" },
      { slug: "impossible-tech", name: "Impossible Tech" },
    ]);
  });

  it("the public catalog shows them as DeluluMart Originals, with price in paise, template and zap flag", async () => {
    const tiffin = await catalogProduct(pool, seedProductId("teleporting-tiffin-box"));
    expect(tiffin).toEqual({
      productId: seedProductId("teleporting-tiffin-box"),
      name: "Teleporting Tiffin Box",
      hook: "Your lunch arrives at your desk the moment you start feeling hungry.",
      description:
        "A steel lunch box with a tiny built-in door to elsewhere. Pack it once; it turns up warm.",
      altText: "Studio photo of a steel tiffin box with a tiny brass door.",
      pricePaise: 299_900n,
      category: "impossible-tech",
      templateId: 12,
      sellerName: "DeluluMart Originals",
      available: true,
      zap: true,
    });
    expect((await catalogProduct(pool, seedProductId("monsoon-in-a-jar")))?.pricePaise).toBe(
      100_000_000_000n,
    );
    const food = await catalogProducts(pool, { category: "food-fantasies" });
    expect(food.items.map((p) => p.productId)).toEqual([seedProductId("monsoon-in-a-jar")]);
  });

  it("changed content becomes a new revision under the same id; the old version is kept", async () => {
    const changed = PRODUCTS.map((p) => (p.id === "pocket-sunset" ? { ...p, priceRupees: 150 } : p));
    expect(await seedCatalog(pool, changed, CATEGORIES)).toEqual({
      categories: 3,
      productsCreated: 0,
      versionsCreated: 1,
    });
    const id = seedProductId("pocket-sunset");
    expect((await catalogProduct(pool, id))?.pricePaise).toBe(15_000n);
    expect(
      await countRows(pool, "SELECT count(*) AS n FROM core.product_version WHERE product_id = $1", [id]),
    ).toBe(2);
    expect(await seedCatalog(pool, changed, CATEGORIES)).toMatchObject({ versionsCreated: 0 });
  });

  it("a seeded product can be bought", async () => {
    const buyer = await user(pool);
    const session = await createCheckoutSession(pool, {
      authSessionId: buyer.authSessionId,
      lines: [{ productId: seedProductId("teleporting-tiffin-box") }],
      speedBySeller: { SEED: "STANDARD" },
      idempotencyKey: key(),
    });
    const attempt = await createPaymentAttempt(pool, {
      authSessionId: buyer.authSessionId,
      sessionId: session.sessionId,
      method: "BALANCE",
    });
    expect(
      await codeOf(
        pay(pool, {
          authSessionId: buyer.authSessionId,
          sessionId: session.sessionId,
          attemptId: attempt.attemptId,
          idempotencyKey: key(),
        }),
      ),
    ).toBe("ok");
  });

  it("refuses invalid input before writing anything", async () => {
    for (const bad of [
      { ...PRODUCTS[0], id: "Not Kebab" },
      { ...PRODUCTS[0], priceRupees: 99 },
      { ...PRODUCTS[0], priceRupees: 100.5 },
      { ...PRODUCTS[0], templateHue: 360 },
      { ...PRODUCTS[0], description: "too short" },
    ] as SeedProductInput[]) {
      expect(await codeOf(seedCatalog(pool, [bad]))).toBe("VALIDATION_FAILED");
    }
    expect(await codeOf(seedCatalog(pool, [PRODUCTS[0], PRODUCTS[0]] as SeedProductInput[]))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("categories are readable by the web role and written by no application role", async () => {
    expect(await stateOf(pool, "SELECT slug FROM core.category", [], { role: "app_web" })).toBe("no error");
    for (const role of ["app_web", "app_pay", "app_jobs"]) {
      expect(
        await stateOf(pool, "INSERT INTO core.category (slug, name) VALUES ('x', 'X')", [], { role }),
        role,
      ).toBe("42501");
    }
  });
});
