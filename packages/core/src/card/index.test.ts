import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { generateCardNumber, luhnValid, maskCardNumber } from "./index";

const cardKey = new TextEncoder().encode("test-card-key-not-a-secret-000000");
const base = {
  cardKey,
  userId: "0190a1b2-0000-7000-8000-000000000001",
  birthdate: "1999-08-15",
  sequence: 0,
  prefix: "042069",
};

describe("luhnValid", () => {
  it("accepts known-valid test numbers and rejects altered ones", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("79927398713")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("4111-1111")).toBe(false);
  });
});

describe("generateCardNumber (US-47)", () => {
  it("US-47: is 16 digits with the fixed prefix", () => {
    const n = generateCardNumber(base);
    expect(n).toMatch(/^\d{16}$/);
    expect(n.startsWith("042069")).toBe(true);
  });

  it("US-47: never passes the Luhn checksum", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.date({ min: new Date("1900-01-01"), max: new Date("2026-01-01"), noInvalidDate: true }),
        fc.nat({ max: 1000 }),
        fc.uint8Array({ minLength: 16, maxLength: 64 }),
        (userId, d, sequence, key) => {
          const n = generateCardNumber({
            cardKey: key,
            userId,
            birthdate: d.toISOString().slice(0, 10),
            sequence,
            prefix: "042069",
          });
          expect(n).toMatch(/^042069\d{10}$/);
          expect(luhnValid(n)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("US-47: is deterministic for the same player and card", () => {
    expect(generateCardNumber(base)).toBe(generateCardNumber({ ...base }));
  });

  it("US-47: a replacement card (next sequence) has a different number", () => {
    expect(generateCardNumber({ ...base, sequence: 1 })).not.toBe(generateCardNumber(base));
  });

  it("US-47: differs with birthdate and with key", () => {
    expect(generateCardNumber({ ...base, birthdate: "1999-08-16" })).not.toBe(generateCardNumber(base));
    expect(generateCardNumber({ ...base, cardKey: new Uint8Array(32) })).not.toBe(generateCardNumber(base));
  });

  it("rejects a prefix that is not six digits beginning with 0", () => {
    for (const prefix of ["142069", "04206", "0420691", "04a069"]) {
      expect(() => generateCardNumber({ ...base, prefix })).toThrow(DomainError);
    }
  });
});

describe("maskCardNumber", () => {
  it("shows the last four digits only", () => {
    const masked = maskCardNumber("0420691234567890");
    expect(masked).toBe("•••• •••• •••• 7890");
    expect(masked).not.toContain("042069");
  });
});
