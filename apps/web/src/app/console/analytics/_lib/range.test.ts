import { describe, expect, it } from "vitest";
import { placeKey, placeLabel } from "./places";
import { defaultRange, parseRange, queryString, shiftDay, todayUtc } from "./range";

const params = (q: string) => new URLSearchParams(q);
const TODAY = "2026-11-21";

describe("analytics range in the URL", () => {
  it("defaults to the last 30 days ending today (UTC)", () => {
    expect(parseRange(params(""), TODAY)).toEqual({ from: "2026-10-23", to: TODAY });
    expect(defaultRange(TODAY, 7)).toEqual({ from: "2026-11-15", to: TODAY });
    expect(todayUtc(new Date("2026-11-21T23:59:59Z"))).toBe(TODAY);
  });
  it("reads a valid shared range", () => {
    expect(parseRange(params("from=2026-01-01&to=2026-01-31"), TODAY)).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });
  it("falls back to the default for malformed, reversed, future or over-long ranges", () => {
    const def = defaultRange(TODAY);
    expect(parseRange(params("from=nope&to=2026-01-31"), TODAY)).toEqual(def);
    expect(parseRange(params("from=2026-02-01&to=2026-01-31"), TODAY)).toEqual(def);
    expect(parseRange(params("from=2026-11-01&to=2026-12-31"), TODAY)).toEqual(def);
    expect(parseRange(params("from=2025-01-01&to=2026-11-21"), TODAY)).toEqual(def);
    expect(parseRange(params("from=2026-01-01"), TODAY)).toEqual(def);
  });
  it("shifts days across month and year ends", () => {
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
  });
  it("builds a query string without empty values", () => {
    expect(queryString({ level: "region", country: "IN", region: null, from: "" })).toBe(
      "level=region&country=IN",
    );
  });
});

describe("place labels", () => {
  const item = {
    country: "IN",
    region: null,
    city: null,
    visitors: 1,
    signUps: 0,
    purchases: 0,
    suppressed: false,
  };
  it("turns the API markers into words", () => {
    expect(placeLabel({ ...item, country: "ZZ" }, "country")).toBe("Unknown location");
    expect(placeLabel({ ...item, country: "Other" }, "country")).toBe("Other (small places combined)");
    expect(placeLabel(item, "region")).toBe("Unknown");
    expect(placeLabel({ ...item, region: "Other" }, "region")).toBe("Other (small places combined)");
    expect(placeLabel({ ...item, city: "Pune" }, "city")).toBe("Pune");
    expect(placeLabel(item, "country")).toMatch(/India|IN/);
  });
  it("only known countries and named regions can be opened", () => {
    expect(placeKey(item, "country")).toBe("IN");
    expect(placeKey({ ...item, country: "ZZ" }, "country")).toBeNull();
    expect(placeKey({ ...item, country: "Other" }, "country")).toBeNull();
    expect(placeKey({ ...item, region: "Goa" }, "region")).toBe("Goa");
    expect(placeKey(item, "region")).toBeNull();
    expect(placeKey({ ...item, city: "Pune" }, "city")).toBeNull();
  });
});
