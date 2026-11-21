import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkListingFields,
  checkPriceRupees,
  checkQuantity,
  LISTING_RULES,
  rupeesToPaise,
  screenListing,
} from "./index";

const valid = {
  name: "Moon Lamp",
  hook: "Mostly moon, partly nap.",
  description: "A lamp that is mostly moon and partly nap, for desks that dream.",
  altText: "A round lamp glowing like a full moon",
  templateId: 42,
};
const codes = (input: Parameters<typeof checkListingFields>[0], required = true) =>
  checkListingFields(input, { required }).map((p) => `${p.field}:${p.code}`);

describe("listing fields (US-08)", () => {
  it("US-08: a complete, well-formed listing has no problems", () => {
    expect(codes(valid)).toEqual([]);
  });

  it("US-08: the length limits are inclusive: name 3-80, hook ≤140, description 20-1,000, alt text ≤300", () => {
    expect(codes({ ...valid, name: "abc" })).toEqual([]);
    expect(codes({ ...valid, name: "ab" })).toEqual(["name:TOO_SHORT"]);
    expect(codes({ ...valid, name: "x".repeat(80) })).toEqual([]);
    expect(codes({ ...valid, name: "x".repeat(81) })).toEqual(["name:TOO_LONG"]);
    expect(codes({ ...valid, hook: "x".repeat(140) })).toEqual([]);
    expect(codes({ ...valid, hook: "x".repeat(141) })).toEqual(["hook:TOO_LONG"]);
    expect(codes({ ...valid, hook: null })).toEqual([]);
    expect(codes({ ...valid, description: "d".repeat(20) })).toEqual([]);
    expect(codes({ ...valid, description: "d".repeat(19) })).toEqual(["description:TOO_SHORT"]);
    expect(codes({ ...valid, description: "d".repeat(1000) })).toEqual([]);
    expect(codes({ ...valid, description: "d".repeat(1001) })).toEqual(["description:TOO_LONG"]);
    expect(codes({ ...valid, altText: "a".repeat(300) })).toEqual([]);
    expect(codes({ ...valid, altText: "a".repeat(301) })).toEqual(["altText:TOO_LONG"]);
  });

  it("US-08: lengths count characters after trimming, not UTF-16 units", () => {
    expect(codes({ ...valid, name: `  ${"🌙".repeat(80)}  ` })).toEqual([]);
    expect(codes({ ...valid, name: "  ab  " })).toEqual(["name:TOO_SHORT"]);
  });

  it("US-08: the illustration is a template from 0 to 359", () => {
    expect(codes({ ...valid, templateId: 0 })).toEqual([]);
    expect(codes({ ...valid, templateId: 359 })).toEqual([]);
    expect(codes({ ...valid, templateId: 360 })).toEqual(["templateId:OUT_OF_RANGE"]);
    expect(codes({ ...valid, templateId: -1 })).toEqual(["templateId:OUT_OF_RANGE"]);
    expect(codes({ ...valid, templateId: 1.5 })).toEqual(["templateId:OUT_OF_RANGE"]);
  });

  it("control characters are refused (a description may hold line breaks)", () => {
    expect(codes({ ...valid, name: "Moon\u0000Lamp" })).toEqual(["name:CONTROL_CHARACTERS"]);
    expect(codes({ ...valid, description: `${valid.description}\nSecond line.` })).toEqual([]);
    expect(codes({ ...valid, description: `${valid.description}\u0007` })).toEqual([
      "description:CONTROL_CHARACTERS",
    ]);
  });

  it("an edit checks only the fields it sends; a draft needs name and description", () => {
    expect(codes({ hook: "x".repeat(141) }, false)).toEqual(["hook:TOO_LONG"]);
    expect(codes({}, false)).toEqual([]);
    expect(codes({}, true)).toEqual(["name:REQUIRED", "description:REQUIRED", "templateId:REQUIRED"]);
  });

  it("US-08: property: TOO_LONG for a name exactly when it has more than 80 characters after trimming", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 120 }), (s) => {
        const n = [...s.trim()].length;
        const problems = codes({ ...valid, name: s });
        expect(problems.includes("name:TOO_LONG")).toBe(n > LISTING_RULES.name.max);
        expect(problems.includes("name:TOO_SHORT")).toBe(n < LISTING_RULES.name.min);
      }),
    );
  });
});

describe("price and quantity (US-08)", () => {
  it("US-08: a price is whole rupees from ₹100 to ₹100 crore", () => {
    expect(checkPriceRupees(100)).toBe(true);
    expect(checkPriceRupees(99)).toBe(false);
    expect(checkPriceRupees(1_000_000_000)).toBe(true);
    expect(checkPriceRupees(1_000_000_001)).toBe(false);
    expect(checkPriceRupees(150.5)).toBe(false);
    expect(checkPriceRupees(Number.NaN)).toBe(false);
  });

  it("property: rupees become exact paise (bigint), always a multiple of 100", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 1_000_000_000 }), (r) => {
        const paise = rupeesToPaise(r);
        expect(typeof paise).toBe("bigint");
        expect(paise).toBe(BigInt(r) * 100n);
        expect(paise % 100n).toBe(0n);
      }),
    );
    expect(() => rupeesToPaise(1.5)).toThrow();
  });

  it("a quantity is a whole number from 1 to the maximum", () => {
    expect(checkQuantity(1)).toBe(true);
    expect(checkQuantity(0)).toBe(false);
    expect(checkQuantity(LISTING_RULES.quantity.max)).toBe(true);
    expect(checkQuantity(LISTING_RULES.quantity.max + 1)).toBe(false);
    expect(checkQuantity(2.5)).toBe(false);
  });
});

describe("listing screening (US-08)", () => {
  it("US-08: clean listing text is OK", () => {
    expect(screenListing(valid).verdict).toBe("OK");
  });

  it("US-08: a link, phone number or payment request in any field rejects, naming the field", () => {
    const r = screenListing({ ...valid, description: `${valid.description} Visit moonlamp.shop now` });
    expect(r.verdict).toBe("REJECT");
    expect(r.reasons).toContainEqual({ field: "description", code: "LINK" });
    const alt = screenListing({ ...valid, altText: "call 9876543210" });
    expect(alt.verdict).toBe("REJECT");
    expect(alt.reasons).toContainEqual({ field: "altText", code: "PHONE" });
    expect(screenListing({ ...valid, hook: "pay via upi please" }).reasons).toContainEqual({
      field: "hook",
      code: "PAYMENT",
    });
  });

  it("US-08: shouting is held for review, not rejected", () => {
    expect(screenListing({ ...valid, name: "MOON LAMP DELUXE" }).verdict).toBe("NEEDS_REVIEW");
  });

  it("a missing hook is screened as empty", () => {
    expect(screenListing({ ...valid, hook: null }).verdict).toBe("OK");
  });
});
