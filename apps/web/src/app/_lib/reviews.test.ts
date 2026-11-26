import { describe, expect, it } from "vitest";
import { formatReviewDay, ineligibleText, reviewFieldErrors, reviewFieldMessage } from "./reviews";

describe("review display helpers", () => {
  it("REV-5: a review's day is shown as a calendar day, never shifted by a time zone", () => {
    expect(formatReviewDay("2026-11-26")).toBe("26 Nov 2026");
    expect(formatReviewDay("2026-01-01")).toBe("1 Jan 2026");
    expect(formatReviewDay("garbage")).toBe("garbage");
  });

  it("REV-2: every refusal code has words, and the first reason per field wins", () => {
    for (const code of [
      "REQUIRED",
      "OUT_OF_RANGE",
      "TOO_LONG",
      "CONTROL_CHARACTERS",
      "LINK",
      "EMAIL",
      "PHONE",
    ])
      expect(reviewFieldMessage("body", code).length).toBeGreaterThan(5);
    expect(reviewFieldErrors({ reasons: [{ field: "rating", code: "REQUIRED" }] })).toEqual({
      rating: "Choose a star rating.",
    });
    expect(
      reviewFieldErrors({
        reasons: [
          { field: "body", code: "LINK" },
          { field: "body", code: "PHONE" },
          { field: "title", code: "TOO_LONG" },
          { field: "other", code: "LINK" },
        ],
      }),
    ).toEqual({ body: "Remove links and web addresses.", title: "Use at most 80 characters." });
    expect(reviewFieldErrors({})).toEqual({});
  });

  it("REV-1: the reasons a person cannot review are explained", () => {
    expect(ineligibleText("NOT_OWNER")).toMatch(/own this product/);
    expect(ineligibleText("SELLER")).toMatch(/sell this product/);
  });
});
