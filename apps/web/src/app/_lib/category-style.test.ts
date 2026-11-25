import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../../data/seed-catalog";
import { CATEGORY_LINKS, motifOfCategory } from "./category-style";

describe("category style", () => {
  it("covers every seed category with a link to its page", () => {
    expect(CATEGORY_LINKS.map((c) => c.href)).toEqual(CATEGORIES.map((c) => `/c/${c.slug}`));
  });
  it("draws a different object for each category", () => {
    expect(new Set(CATEGORY_LINKS.map((c) => c.motif)).size).toBe(CATEGORIES.length);
  });
  it("falls back to a motif for an unknown category", () => {
    expect(motifOfCategory("nope")).toBe("magic");
    expect(motifOfCategory("food-fantasies")).toBe("food");
  });
});
