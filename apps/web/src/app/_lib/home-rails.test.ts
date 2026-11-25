import { describe, expect, it } from "vitest";
import type { ProductResponse } from "./api";
import { HOME_CONFIG } from "./home-config";
import { deriveHomeRails } from "./home-rails";

const product = (id: string, category: string, pricePaise: string, available = true): ProductResponse => ({
  id,
  name: id,
  hook: null,
  description: "d",
  altText: "a",
  pricePaise,
  category,
  templateId: 1,
  sellerName: null,
  available,
  zap: false,
});
const categories = [
  { slug: "a", name: "A" },
  { slug: "b", name: "B" },
];
// 30 products in category a, with prices that sort differently as strings than as numbers
const many = Array.from({ length: 30 }, (_, i) =>
  product(`a${i}`, "a", String((i + 1) * 100_00 + (i % 2) * 7)),
);

describe("deriveHomeRails", () => {
  it("compares prices as numbers of paise, not as text: pocket change is the cheapest, big flex the dearest", () => {
    const rails = deriveHomeRails(
      [...many, product("huge", "a", "99999999999999"), product("tiny", "a", "9999")],
      categories,
    );
    const pocket = rails.find((r) => r.key === "pocket-change");
    const flex = rails.find((r) => r.key === "big-flex");
    expect(pocket?.products[0]?.id).toBe("tiny");
    expect(pocket?.products).toHaveLength(HOME_CONFIG.rails.pocketChangeCount);
    expect(flex?.products[0]?.id).toBe("huge");
    expect(flex?.products).toHaveLength(HOME_CONFIG.rails.bigFlexCount);
  });
  it("leaves out unavailable products and rails with nothing in them", () => {
    const rails = deriveHomeRails([product("x", "a", "100000", false)], categories);
    expect(rails).toEqual([]);
  });
  it("adds a category rail only when the category has enough products, capped by configuration", () => {
    const rails = deriveHomeRails([...many, product("b1", "b", "100000")], categories);
    const keys = rails.map((r) => r.key);
    expect(keys).toContain("category-a");
    expect(keys).not.toContain("category-b");
    expect(rails.find((r) => r.key === "category-a")?.products).toHaveLength(
      HOME_CONFIG.rails.categoryRailCount,
    );
  });
  it("keeps the fixed rails first, in order", () => {
    const keys = deriveHomeRails(many, categories).map((r) => r.key);
    expect(keys.slice(0, 3)).toEqual(["fresh", "pocket-change", "big-flex"]);
  });
});

describe("representativeOf and lowestPriceOf", () => {
  it("pick the first available product and the lowest price of a category, comparing bigint paise", async () => {
    const { representativeOf, lowestPriceOf } = await import("./home-rails");
    const items = [
      product("gone", "a", "100", false),
      product("one", "a", "99999999999999"),
      product("two", "a", "9999"),
      product("other", "b", "5"),
    ];
    expect(representativeOf(items, "a")?.id).toBe("one");
    expect(lowestPriceOf(items, "a")).toBe(9999n);
    expect(lowestPriceOf(items, "z")).toBeUndefined();
  });
});
