import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkBirthdate } from "./identity";

const TODAY = "2026-11-21";

function code(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "non-domain error";
  }
}

describe("checkBirthdate (fifth security review, absurd birthdates)", () => {
  it("US-01: a date after today is VALIDATION_FAILED", () => {
    for (const d of ["2026-11-22", "2027-01-01", "9999-12-31"])
      expect(code(() => checkBirthdate(d, TODAY))).toBe("VALIDATION_FAILED");
  });

  it("US-01: a date more than 120 years before today is VALIDATION_FAILED; exactly 120 is accepted", () => {
    for (const d of ["1906-11-20", "1800-01-01", "0001-01-01"])
      expect(code(() => checkBirthdate(d, TODAY))).toBe("VALIDATION_FAILED");
    expect(checkBirthdate("1906-11-21", TODAY)).toBe(true);
  });

  it("US-01: today and other recent dates are minors, not errors", () => {
    expect(checkBirthdate(TODAY, TODAY)).toBe(false);
    expect(checkBirthdate("2008-11-22", TODAY)).toBe(false);
    expect(checkBirthdate("2008-11-21", TODAY)).toBe(true);
  });

  it("US-01: for every real date the answer is VALIDATION_FAILED exactly outside [today-120y, today]", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("0100-01-01"), max: new Date("9999-12-31"), noInvalidDate: true }),
        (date) => {
          const d = date.toISOString().slice(0, 10);
          const outcome = code(() => checkBirthdate(d, TODAY));
          const outside = d > TODAY || d < "1906-11-21";
          expect(outcome === "VALIDATION_FAILED").toBe(outside);
        },
      ),
    );
  });
});
