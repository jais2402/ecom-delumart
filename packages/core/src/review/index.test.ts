import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import {
  averageTenths,
  checkReview,
  distributionPercents,
  formatAverage,
  REVIEW_RULES,
  ratingLabel,
  requireValidReview,
} from "./index";

const codes = (input: Parameters<typeof checkReview>[0]) => {
  const r = checkReview(input);
  return r.ok ? [] : r.problems.map((p) => `${p.field}:${p.code}`);
};

describe("review input (ratings and reviews, decisions.md #14)", () => {
  it("REV-2: a rating alone is a complete review; empty title and body become null", () => {
    expect(checkReview({ rating: 4 })).toEqual({ ok: true, value: { rating: 4, title: null, body: null } });
    expect(checkReview({ rating: 5, title: "  ", body: "\n" })).toEqual({
      ok: true,
      value: { rating: 5, title: null, body: null },
    });
  });

  it("REV-2: title and body are trimmed and kept", () => {
    expect(checkReview({ rating: 3, title: "  Mostly moon  ", body: " Naps well.\nGlows softly. " })).toEqual(
      {
        ok: true,
        value: { rating: 3, title: "Mostly moon", body: "Naps well.\nGlows softly." },
      },
    );
  });

  it("REV-2: the rating is a whole number from 1 to 5 and is required", () => {
    for (const rating of [1, 2, 3, 4, 5]) expect(codes({ rating })).toEqual([]);
    for (const rating of [0, 6, -1, 2.5, Number.NaN, "4"])
      expect(codes({ rating }), String(rating)).toEqual(["rating:OUT_OF_RANGE"]);
    for (const rating of [null, undefined]) expect(codes({ rating })).toEqual(["rating:REQUIRED"]);
  });

  it("REV-2: the length limits are inclusive: title up to 80 characters, body up to 1,000", () => {
    expect(REVIEW_RULES).toMatchObject({ titleMaxChars: 80, bodyMaxChars: 1000, pageSize: 10 });
    expect(codes({ rating: 4, title: "t".repeat(80) })).toEqual([]);
    expect(codes({ rating: 4, title: "t".repeat(81) })).toEqual(["title:TOO_LONG"]);
    expect(codes({ rating: 4, body: "b".repeat(1000) })).toEqual([]);
    expect(codes({ rating: 4, body: "b".repeat(1001) })).toEqual(["body:TOO_LONG"]);
    // characters, not UTF-16 units
    expect(codes({ rating: 4, title: "🌙".repeat(80) })).toEqual([]);
  });

  it("REV-2: control characters are refused (a line break is allowed in the body only)", () => {
    expect(codes({ rating: 4, title: "a\nb" })).toEqual(["title:CONTROL_CHARACTERS"]);
    expect(codes({ rating: 4, body: "a\nb" })).toEqual([]);
    expect(codes({ rating: 4, body: "a\u0007b" })).toEqual(["body:CONTROL_CHARACTERS"]);
  });

  it("REV-2: links, emails, phone and card-like numbers are refused per field, never echoed", () => {
    const cases: [Record<string, string>, string][] = [
      [{ body: "see www.example.com for more" }, "body:LINK"],
      [{ title: "write to moon@example.com" }, "title:EMAIL"],
      [{ body: "call 98765 43210 now" }, "body:PHONE"],
      [{ body: "my card 4111 1111 1111 1111" }, "body:PHONE"],
    ];
    for (const [fields, expected] of cases) {
      const result = checkReview({ rating: 2, ...fields });
      expect(result.ok, expected).toBe(false);
      if (!result.ok) {
        expect(result.problems.map((p) => `${p.field}:${p.code}`)).toContain(expected);
        expect(JSON.stringify(result.problems)).not.toContain("example");
        expect(JSON.stringify(result.problems)).not.toContain("4111");
      }
    }
  });

  it("REV-2: text the screening would send to a person (not OK) is refused too: there is no review queue", () => {
    const r = checkReview({ rating: 2, title: "OFFICIAL DELULUMART VERIFIED SELLER" });
    expect(r.ok).toBe(false);
  });

  it("REV-2: shape problems are reported before screening, for every field at once", () => {
    expect(codes({ rating: 9, title: "t".repeat(81), body: "b".repeat(1001) })).toEqual([
      "rating:OUT_OF_RANGE",
      "title:TOO_LONG",
      "body:TOO_LONG",
    ]);
  });

  it("REV-2: requireValidReview throws REVIEW_INVALID with field reasons only", () => {
    expect(requireValidReview({ rating: 5, title: "Lovely" })).toEqual({
      rating: 5,
      title: "Lovely",
      body: null,
    });
    try {
      requireValidReview({ rating: 0, body: "mail me at moon@example.com" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const e = error as DomainError;
      expect(e.code).toBe("REVIEW_INVALID");
      expect(e.details).toEqual({ reasons: [{ field: "rating", code: "OUT_OF_RANGE" }] });
      expect(e.message).not.toContain("moon");
    }
  });
});

describe("review averages from integer sums (no floats stored or sent)", () => {
  it("REV-3: averageTenths is the average times ten, rounded half up; 0 with no reviews", () => {
    expect(averageTenths(0, 0)).toBe(0);
    expect(averageTenths(5, 1)).toBe(50);
    expect(averageTenths(9, 2)).toBe(45);
    expect(averageTenths(13, 3)).toBe(43); // 4.333...
    expect(averageTenths(14, 3)).toBe(47); // 4.666...
    expect(averageTenths(43, 10)).toBe(43);
    expect(averageTenths(29, 20)).toBe(15); // 1.45 rounds half up
  });

  it("REV-3 (property): for any set of ratings, averageTenths lies in [10, 50] and within half a tenth of the true mean", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 500 }), (ratings) => {
        const sum = ratings.reduce((a, b) => a + b, 0);
        const t = averageTenths(sum, ratings.length);
        expect(Number.isInteger(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(10);
        expect(t).toBeLessThanOrEqual(50);
        // |t/10 - sum/n| <= 1/20, checked in integers: |2tn - 20 sum| <= n
        expect(Math.abs(2 * t * ratings.length - 20 * sum)).toBeLessThanOrEqual(ratings.length);
      }),
    );
  });

  it("REV-3: the average is shown with one decimal and an accessible label", () => {
    expect(formatAverage(43)).toBe("4.3");
    expect(formatAverage(50)).toBe("5.0");
    expect(formatAverage(0)).toBe("0.0");
    expect(ratingLabel(43, 12)).toBe("4.3 out of 5 stars, 12 reviews");
    expect(ratingLabel(50, 1)).toBe("5.0 out of 5 stars, 1 review");
    expect(ratingLabel(0, 0)).toBe("No reviews yet");
  });

  it("REV-3 (property): distribution percentages are whole numbers from 0 to 100, one per star, 0 when empty", () => {
    expect(distributionPercents([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
    expect(distributionPercents([1, 0, 0, 0, 3])).toEqual([25, 0, 0, 0, 75]);
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 10_000 }), { minLength: 5, maxLength: 5 }), (counts) => {
        const p = distributionPercents(counts);
        expect(p).toHaveLength(5);
        for (const v of p) expect(Number.isInteger(v) && v >= 0 && v <= 100).toBe(true);
      }),
    );
  });
});
