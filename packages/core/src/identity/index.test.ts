import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import {
  assertAdult,
  DEFAULT_IDENTITY_CONFIG,
  fingerprint,
  isAdult,
  normalizeEmail,
  normalizePhone,
  type PhoneCountryRule,
} from "./index";

const key = new TextEncoder().encode("test-identity-key");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
  return undefined;
}

describe("normalizeEmail (US-49)", () => {
  it("US-49: lowercases and trims", () => {
    expect(normalizeEmail("  Asha.Rao@Example.COM ")).toBe("asha.rao@example.com");
  });

  it("US-49: Gmail addresses differing by case, dots or +tag normalise to one", () => {
    const variants = [
      "asha.rao@gmail.com",
      "AshaRao@Gmail.com",
      "a.s.h.a.rao+shopping@gmail.com",
      "asharao+x@googlemail.com",
    ];
    for (const v of variants) expect(normalizeEmail(v)).toBe("asharao@gmail.com");
  });

  it("keeps dots and +tags for non-Gmail domains", () => {
    expect(normalizeEmail("a.b+c@example.com")).toBe("a.b+c@example.com");
  });

  it("rejects malformed addresses", () => {
    for (const v of ["", "no-at-sign", "a@b@c.com", "@example.com", "a@", "+tag@gmail.com"]) {
      expect(
        codeOf(() => normalizeEmail(v)),
        v,
      ).toBe("VALIDATION_FAILED");
    }
  });

  it("US-49: strips a trailing dot from the domain", () => {
    expect(normalizeEmail("asha@example.com.")).toBe("asha@example.com");
    expect(fingerprint(key, normalizeEmail("J.Doe@Gmail.Com."))).toBe(
      fingerprint(key, normalizeEmail("jdoe@gmail.com")),
    );
  });

  it("rejects a domain without a dot or with empty labels", () => {
    for (const v of ["a@localhost", "a@example", "a@.com", "a@example..com", "a@example.com..", "a@."]) {
      expect(
        codeOf(() => normalizeEmail(v)),
        v,
      ).toBe("VALIDATION_FAILED");
    }
  });

  it("is idempotent (property)", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (e) => {
        const once = normalizeEmail(e);
        expect(normalizeEmail(once)).toBe(once);
      }),
    );
  });
});

describe("normalizePhone (US-49)", () => {
  const allow: readonly PhoneCountryRule[] = [
    { callingCode: "91", nationalLength: 10, leadingDigits: "6789" },
    { callingCode: "1", nationalLength: 10, leadingDigits: "23456789" },
    { callingCode: "44", nationalLength: 10, leadingDigits: "7" },
  ];

  it("accepts E.164 numbers in an allowed country", () => {
    expect(normalizePhone("+919876543210", allow)).toBe("+919876543210");
    expect(normalizePhone(" +14155550123 ", allow)).toBe("+14155550123");
    expect(normalizePhone("+447700900123", allow)).toBe("+447700900123");
  });

  it("US-49: strips spaces, hyphens and parentheses before validating", () => {
    expect(normalizePhone("+91 98765 43210", allow)).toBe("+919876543210");
    expect(normalizePhone("+91-9876543210", allow)).toBe("+919876543210");
    expect(normalizePhone("+1 (415) 555-0123", allow)).toBe("+14155550123");
  });

  it("defaults to India (+91) only: 10 digits starting 6–9", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+916000000001")).toBe("+916000000001");
    for (const v of ["+911234", "+9100000", "+910000000000", "+915876543210", "+14155550123", "+9198765432101"]) {
      expect(
        codeOf(() => normalizePhone(v)),
        v,
      ).toBe("PHONE_INVALID");
    }
    expect(DEFAULT_IDENTITY_CONFIG.phoneCountries).toEqual([
      { callingCode: "91", nationalLength: 10, leadingDigits: "6789" },
    ]);
  });

  it("throws PHONE_INVALID for non-E.164 input, a wrong length or leading digit, or a country not allowed", () => {
    for (const v of [
      "9876543210",
      "+0919876543210",
      "+8613800138000",
      "+9198765432101234",
      "+91",
      "+911234",
      "+9100000",
      "+910000000000",
      "+91 98765 4321",
      "+91.9876543210",
      "+91 98765 43210 ext 1",
      "++919876543210",
    ]) {
      expect(
        codeOf(() => normalizePhone(v, allow)),
        v,
      ).toBe("PHONE_INVALID");
    }
  });
});

describe("fingerprint", () => {
  it("is HMAC-SHA-256 hex, deterministic and key-dependent", () => {
    const a = fingerprint(key, "asharao@gmail.com");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(key, "asharao@gmail.com")).toBe(a);
    expect(fingerprint(new Uint8Array(16), "asharao@gmail.com")).not.toBe(a);
    expect(a).not.toContain("asharao");
  });

  it("US-49: Gmail variants share a fingerprint after normalisation", () => {
    expect(fingerprint(key, normalizeEmail("Asha.Rao+x@gmail.com"))).toBe(
      fingerprint(key, normalizeEmail("asharao@googlemail.com")),
    );
  });

  it("matches known HMAC-SHA-256 test vector (RFC 4231 case 2)", () => {
    expect(fingerprint(new TextEncoder().encode("Jefe"), "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("isAdult", () => {
  it("is 18+ exactly on the 18th birthday and not the day before", () => {
    expect(isAdult("2008-11-20", "2026-11-20")).toBe(true);
    expect(isAdult("2008-11-21", "2026-11-20")).toBe(false);
    expect(isAdult("1990-01-01", "2026-11-20")).toBe(true);
  });

  it("a 29 February birthday becomes adult on 1 March in a non-leap year", () => {
    expect(isAdult("2008-02-29", "2026-02-28")).toBe(false);
    expect(isAdult("2008-02-29", "2026-03-01")).toBe(true);
  });

  it("assertAdult throws UNDERAGE for minors", () => {
    expect(codeOf(() => assertAdult("2010-05-05", "2026-11-20"))).toBe("UNDERAGE");
    expect(codeOf(() => assertAdult("2000-05-05", "2026-11-20"))).toBeUndefined();
  });

  it("adult age comes from config", () => {
    expect(DEFAULT_IDENTITY_CONFIG.adultAgeYears).toBe(18);
    expect(isAdult("2005-11-20", "2026-11-20", 21)).toBe(true);
    expect(isAdult("2005-11-21", "2026-11-20", 21)).toBe(false);
    expect(codeOf(() => assertAdult("2006-05-05", "2026-11-20", 21))).toBe("UNDERAGE");
  });

  it("rejects impossible dates", () => {
    expect(codeOf(() => isAdult("2001-02-30", "2026-11-20"))).toBe("VALIDATION_FAILED");
    expect(codeOf(() => isAdult("01-01-2001", "2026-11-20"))).toBe("VALIDATION_FAILED");
  });
});
