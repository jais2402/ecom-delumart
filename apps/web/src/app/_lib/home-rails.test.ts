import { describe, expect, it } from "vitest";
import type { ProductResponse } from "./api";
import { HOME_CONFIG } from "./home-config";
import { deriveHomeRails, deriveTopPicks, pickHeroProducts, TOP_PICKS_ALL } from "./home-rails";

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
    const rails = deriveHomeRails([
      ...many,
      product("huge", "a", "99999999999999"),
      product("tiny", "a", "9999"),
    ]);
    const pocket = rails.find((r) => r.key === "pocket-change");
    const flex = rails.find((r) => r.key === "big-flex");
    expect(pocket?.products[0]?.id).toBe("tiny");
    expect(pocket?.products).toHaveLength(HOME_CONFIG.rails.pocketChangeCount);
    expect(flex?.products[0]?.id).toBe("huge");
    expect(flex?.products).toHaveLength(HOME_CONFIG.rails.bigFlexCount);
  });
  it("leaves out unavailable products and rails with nothing in them", () => {
    expect(deriveHomeRails([product("x", "a", "100000", false)])).toEqual([]);
  });
  it("keeps only the lowest-price and premium rails, in that order, with no category rails", () => {
    const keys = deriveHomeRails([...many, product("b1", "b", "100000")]).map((r) => r.key);
    expect(keys).toEqual(["pocket-change", "big-flex"]);
  });
  it("leaves the hero's products out of the premium rail so no card repeats", () => {
    const hero = new Set(["a29", "a28"]);
    const flex = deriveHomeRails(many, hero).find((r) => r.key === "big-flex");
    expect(flex?.products.map((p) => p.id)).not.toContain("a29");
    expect(flex?.products.map((p) => p.id)).not.toContain("a28");
    expect(flex?.products[0]?.id).toBe("a27");
  });
});

describe("pickHeroProducts", () => {
  it("takes the dearest available products, up to the configured count, comparing bigint paise", () => {
    const picks = pickHeroProducts([
      ...many,
      product("huge", "a", "99999999999999"),
      product("gone", "a", "999999999999999", false),
    ]);
    expect(picks).toHaveLength(HOME_CONFIG.hero.slideCount);
    expect(picks[0]?.id).toBe("huge");
    expect(picks.map((p) => p.id)).not.toContain("gone");
    expect(picks[1]?.id).toBe("a29");
  });
  it("is the same for the same catalogue", () => {
    expect(pickHeroProducts(many).map((p) => p.id)).toEqual(pickHeroProducts([...many]).map((p) => p.id));
  });
});

describe("deriveTopPicks", () => {
  it("starts with an All tab with no View all destination, then one tab per category that has products", () => {
    const tabs = deriveTopPicks([...many, product("b1", "b", "100000")], categories);
    expect(tabs.map((t) => t.key)).toEqual([TOP_PICKS_ALL, "a", "b"]);
    expect(tabs.map((t) => t.label)).toEqual(["All", "A", "B"]);
    expect(tabs[0]?.href).toBeUndefined();
    expect(tabs[1]?.href).toBe("/c/a");
  });
  it("caps each tab by configuration and leaves out unavailable products and empty categories", () => {
    const tabs = deriveTopPicks([...many, product("b1", "b", "100000", false)], categories);
    expect(tabs.map((t) => t.key)).toEqual([TOP_PICKS_ALL, "a"]);
    for (const tab of tabs) expect(tab.products.length).toBeLessThanOrEqual(HOME_CONFIG.topPicks.perTab);
    expect(tabs.every((t) => t.products.every((p) => p.available))).toBe(true);
  });
  it("has no tabs at all for an empty catalogue", () => {
    expect(deriveTopPicks([], categories)).toEqual([]);
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
