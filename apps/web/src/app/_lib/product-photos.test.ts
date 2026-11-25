import { describe, expect, it } from "vitest";
import { SEED_PRODUCTS } from "../../data/seed-catalog";
import { PRODUCT_PHOTOS, photoSrcOf } from "./product-photos";

const seed = SEED_PRODUCTS[0];
const platform = { name: seed?.name ?? "", sellerKey: "SEED", sellerName: null } as const;

describe("product photos", () => {
  it("gives a platform seed product its same-origin photo when the manifest has one", () => {
    expect(photoSrcOf(platform, { [seed?.id ?? ""]: "a.webp" })).toBe("/products/a.webp");
  });
  it("leaves a product with no entry on generated art", () => {
    expect(photoSrcOf(platform, {})).toBeUndefined();
  });
  it("never gives a creator's listing a seed product's photo, even with the same name", () => {
    const photos = { [seed?.id ?? ""]: "a.webp" };
    expect(
      photoSrcOf({ ...platform, sellerKey: "company-1", sellerName: "Some Shop" }, photos),
    ).toBeUndefined();
  });
  it("only names files for real seed products", () => {
    const ids = new Set(SEED_PRODUCTS.map((s) => s.id));
    for (const id of Object.keys(PRODUCT_PHOTOS)) expect(ids.has(id)).toBe(true);
  });
});
