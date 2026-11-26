import { describe, expect, it } from "vitest";
import type { ProductResponse } from "./api";
import { suggestionsFor } from "./search-suggestions";

const product = (id: string, name: string, hook?: string) =>
  ({ id, name, hook }) as unknown as ProductResponse;
const products = [
  product("1", "Monsoon in a Jar", "Rain on demand"),
  product("2", "Moon Crater Snow Globe"),
  product("3", "Gold Chai Strainer"),
];
const categories = [{ slug: "cosmic-collectibles", name: "Cosmic Collectibles" }];

describe("suggestionsFor", () => {
  it("gives nothing below two characters", () => {
    expect(suggestionsFor("m", products, categories)).toEqual([]);
  });
  it("matches names and hooks the way the search page does, ignoring case", () => {
    expect(suggestionsFor("MONS", products, categories).map((r) => r.label)).toEqual(["Monsoon in a Jar"]);
    expect(suggestionsFor("moon", products, categories).map((r) => r.label)).toEqual([
      "Moon Crater Snow Globe",
    ]);
    expect(suggestionsFor("demand", products, categories).map((r) => r.href)).toEqual(["/p/1"]);
  });
  it("lists matching departments first, linked to their pages", () => {
    const result = suggestionsFor("cosmic", products, categories);
    expect(result[0]).toMatchObject({ kind: "Department", href: "/c/cosmic-collectibles" });
  });
});
