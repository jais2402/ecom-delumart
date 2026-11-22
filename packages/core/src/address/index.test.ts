import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError, ERROR_CODES } from "../errors/index";
import {
  ADDRESS_LABELS,
  ADDRESS_RULES,
  type AddressInput,
  addressFromJson,
  addressToJson,
  formatAddress,
  INDIA_REGIONS,
  SUPPORTED_ADDRESS_COUNTRIES,
  validateAddress,
} from "./index";

function problemsOf(input: AddressInput): { field: string; code: string }[] {
  try {
    validateAddress(input);
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    const err = e as DomainError;
    expect(err.code).toBe("VALIDATION_FAILED");
    return err.details.issues as { field: string; code: string }[];
  }
  return [];
}

const home: AddressInput = {
  recipientName: "Asha Rao",
  line1: "Flat 4B, Sai Krupa Apartments",
  line2: "12/3, 2nd Cross, Indiranagar",
  city: "Bengaluru",
  state: "KA",
  postalCode: "560038",
  country: "IN",
};

/** Realistic Indian addresses: slashes, commas, c/o, flat numbers, hyphens, apostrophes, Devanagari. */
const REALISTIC: AddressInput[] = [
  home,
  {
    recipientName: "R. K. Sharma",
    line1: "c/o Mrs. Meena Sharma, H.No. 1-2-345/A",
    line2: "Near Old Water Tank, Ward No. 7",
    city: "Hyderabad",
    state: "TS",
    postalCode: "500 029",
    country: "IN",
  },
  {
    recipientName: "D'Souza Family",
    line1: "B-302, Sea Breeze CHS, Plot No. 14, Sector 17",
    city: "Navi Mumbai",
    state: "MH",
    postalCode: "400703",
    country: "IN",
  },
  {
    recipientName: "अमित कुमार",
    line1: "मकान नं. 45, गली नं. 3",
    line2: "लाजपत नगर - IV",
    city: "नई दिल्ली",
    state: "DL",
    postalCode: "110024",
    country: "IN",
  },
  {
    recipientName: "Priya (Work)",
    line1: "4th Floor, Tower C; DLF Cyber City Phase-II",
    line2: "Opp. Ambience Mall & Food Court #2",
    city: "Gurugram",
    state: "HR",
    postalCode: "122002",
    country: "IN",
  },
];

describe("validateAddress (PRD R5.2)", () => {
  it("R5.2: accepts realistic Indian addresses with slashes, commas, c/o and flat numbers", () => {
    for (const a of REALISTIC) expect(problemsOf(a), a.line1).toEqual([]);
  });

  it("R5.2: normalises whitespace, a spaced PIN code and an empty line 2", () => {
    const v = validateAddress({
      ...home,
      recipientName: "  Asha   Rao ",
      line2: "   ",
      postalCode: " 560 038 ",
      state: "ka",
    });
    expect(v).toEqual({ ...home, recipientName: "Asha Rao", line2: null, postalCode: "560038", state: "KA" });
  });

  it("R5.2: the fields are exactly name, two lines, city, state and PIN code (no phone, no landmark)", () => {
    expect(Object.keys(validateAddress(home)).sort()).toEqual(
      ["city", "country", "line1", "line2", "postalCode", "recipientName", "state"].sort(),
    );
  });

  it("R5.2: a PIN code is six digits not starting with 0 (format only)", () => {
    for (const bad of ["56003", "5600381", "060038", "56A038", "", "560-038"]) {
      expect(problemsOf({ ...home, postalCode: bad }), bad).toContainEqual({
        field: "postalCode",
        code: "INVALID",
      });
    }
  });

  it("R5.2: the state must be one of India's states and union territories", () => {
    expect(problemsOf({ ...home, state: "XX" })).toContainEqual({ field: "state", code: "INVALID" });
    expect(problemsOf({ ...home, state: "Karnataka" })).toContainEqual({ field: "state", code: "INVALID" });
    expect(INDIA_REGIONS).toHaveLength(36);
    expect(new Set(INDIA_REGIONS.map((r) => r.code)).size).toBe(36);
  });

  it("R5.2: India only in this release (decisions.md #3); other countries are refused", () => {
    expect(SUPPORTED_ADDRESS_COUNTRIES).toEqual(["IN"]);
    expect(problemsOf({ ...home, country: "US" })).toContainEqual({ field: "country", code: "UNSUPPORTED" });
  });

  it("R5.2: required fields are required and every field has a length cap", () => {
    expect(problemsOf({ ...home, recipientName: " " })).toContainEqual({
      field: "recipientName",
      code: "REQUIRED",
    });
    expect(problemsOf({ ...home, line1: "" })).toContainEqual({ field: "line1", code: "REQUIRED" });
    expect(problemsOf({ ...home, city: "" })).toContainEqual({ field: "city", code: "REQUIRED" });
    const long = "a".repeat(ADDRESS_RULES.lineMaxChars + 1);
    expect(problemsOf({ ...home, line1: long })).toContainEqual({ field: "line1", code: "TOO_LONG" });
    expect(problemsOf({ ...home, line2: long })).toContainEqual({ field: "line2", code: "TOO_LONG" });
    expect(problemsOf({ ...home, recipientName: "a".repeat(ADDRESS_RULES.nameMaxChars + 1) })).toContainEqual({
      field: "recipientName",
      code: "TOO_LONG",
    });
    expect(problemsOf({ ...home, city: "a".repeat(ADDRESS_RULES.cityMaxChars + 1) })).toContainEqual({
      field: "city",
      code: "TOO_LONG",
    });
  });

  it("R5.2: control characters and markup brackets are refused", () => {
    expect(problemsOf({ ...home, line1: "Flat 1\u0000" })).toContainEqual({ field: "line1", code: "CHARACTERS" });
    expect(problemsOf({ ...home, line2: "<script>" })).toContainEqual({ field: "line2", code: "CHARACTERS" });
  });

  it("invariant 7 / decisions.md #5: no phone or card number in an address (long digit runs refused)", () => {
    for (const run of ["4111 1111 1111 1111", "98450 12345", "+91-98450-12345", "4111-1111-1111-1111"]) {
      expect(problemsOf({ ...home, line2: `Call ${run}` }), run).toContainEqual({
        field: "line2",
        code: "DIGITS",
      });
    }
    // ordinary numbers in addresses stay fine
    expect(problemsOf({ ...home, line1: "H.No. 1-2-345/A, Plot 14, Sector 17" })).toEqual([]);
  });

  it("property: anything validateAddress returns validates again to itself (idempotent)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REALISTIC),
        fc.string({ maxLength: 4 }).map((s) => s.replace(/[^ ]/g, " ")),
        (a, pad) => {
          const once = validateAddress({ ...a, line1: `${pad}${a.line1}${pad}` });
          expect(validateAddress({ ...once, line2: once.line2 ?? "" })).toEqual(once);
        },
      ),
    );
  });

  it("property: arbitrary text never throws anything but VALIDATION_FAILED", () => {
    fc.assert(
      fc.property(
        fc.record({
          recipientName: fc.string(),
          line1: fc.string(),
          line2: fc.option(fc.string(), { nil: undefined }),
          city: fc.string(),
          state: fc.string(),
          postalCode: fc.string(),
          country: fc.string(),
        }),
        (input) => {
          try {
            validateAddress(input);
          } catch (e) {
            expect(e).toBeInstanceOf(DomainError);
            expect((e as DomainError).code).toBe("VALIDATION_FAILED");
          }
        },
      ),
    );
  });
});

describe("address payload and display", () => {
  it("R5.2: the encrypted payload round-trips through JSON", () => {
    const v = validateAddress(REALISTIC[1] as AddressInput);
    expect(addressFromJson(addressToJson(v))).toEqual(v);
  });

  it("addressFromJson refuses anything that is not a valid payload", () => {
    expect(() => addressFromJson("{}")).toThrow(DomainError);
    expect(() => addressFromJson("not json")).toThrow(DomainError);
  });

  it("formatAddress gives one readable line with the state name", () => {
    expect(formatAddress(validateAddress(home))).toBe(
      "Asha Rao, Flat 4B, Sai Krupa Apartments, 12/3, 2nd Cross, Indiranagar, Bengaluru, Karnataka 560038",
    );
  });

  it("labels are Home, Work and Other; at most five addresses (R5.2)", () => {
    expect(ADDRESS_LABELS).toEqual(["HOME", "WORK", "OTHER"]);
    expect(ADDRESS_RULES.maxPerUser).toBe(5);
  });

  it("address error codes are stable", () => {
    expect(ERROR_CODES).toContain("ADDRESS_NOT_FOUND");
    expect(ERROR_CODES).toContain("ADDRESS_LIMIT");
  });
});
