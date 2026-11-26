import type { ProductGridItem } from "@delulu/ui";
import { describe, expect, it } from "vitest";
import { sortItems } from "./sort-items";

const item = (id: string, name: string, pricePaise: bigint) =>
  ({ id, name, pricePaise, href: "/", hue: 0, storeName: "S" }) as ProductGridItem;
// two prices that differ only beyond what a double can hold, to prove the comparison is exact
const items = [
  item("a", "Banana", 90_000_000_000_000_001n),
  item("b", "apple", 90_000_000_000_000_000n),
  item("c", "Cherry", 5n),
];

describe("sortItems", () => {
  it("keeps the given order for Best match, without changing the input", () => {
    expect(sortItems(items, "match").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts by price as exact bigint paise, both ways", () => {
    expect(sortItems(items, "price-asc").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(sortItems(items, "price-desc").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  it("sorts by name A to Z ignoring case", () => {
    expect(sortItems(items, "name").map((i) => i.name)).toEqual(["apple", "Banana", "Cherry"]);
  });
});
