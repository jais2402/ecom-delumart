import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../errors/index";
import {
  CHALLENGE_RULES,
  DECLINE_REASONS,
  describeFailure,
  displayStatus,
  looksLikeRealPaymentData,
  PAYMENT_METHODS,
  PAYMENT_SCENARIOS,
  parseDeluluPayId,
  reservedScenarioOf,
  TEST_DELULUPAY_IDS,
} from "./index";

describe("PRD R4.3 decline reasons", () => {
  const REQUIRED = [
    "INSUFFICIENT_FUNDS",
    "CARD_FROZEN",
    "CARD_REPLACED",
    "CHALLENGE_FAILED",
    "CHALLENGE_EXPIRED",
    "CHALLENGE_LOCKED",
    "CANCELLED",
    "METHOD_UNAVAILABLE",
    "METHOD_LIMIT_EXCEEDED",
    "BANK_UNAVAILABLE",
    "CHECKOUT_EXPIRED",
    "TEST_INSUFFICIENT_FUNDS",
  ] as const;

  it("US-34: every PRD decline reason has wording that says no fictional money moved", () => {
    for (const code of REQUIRED) {
      const reason = DECLINE_REASONS[code];
      expect(reason, code).toBeDefined();
      expect(reason?.message, code).toMatch(/No fictional money moved\./);
    }
  });

  it("US-34: an unknown or future failure code still says no money moved, and never echoes the code", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z_]{4,30}$/), (code) => {
        const d = describeFailure(code);
        expect(d.message).toMatch(/No fictional money moved\./);
        if (!(code in DECLINE_REASONS)) expect(d.message).not.toContain(code);
      }),
    );
  });

  it("the stable codes the API throws are all error codes (R10)", () => {
    for (const code of [
      "METHOD_LIMIT_EXCEEDED",
      "CHALLENGE_FAILED",
      "CHALLENGE_EXPIRED",
      "CHALLENGE_LOCKED",
      "METHOD_UNAVAILABLE",
      "BANK_UNAVAILABLE",
    ]) {
      expect(ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});

describe("PRD R4.3 status model", () => {
  const base = {
    state: "PENDING" as const,
    authenticated: false,
    challengeIssued: false,
    sessionLive: true,
    reversed: false,
  };
  it("US-34: Created, Authenticating, Authorised, Captured, Failed and Refunded", () => {
    expect(displayStatus(base)).toBe("CREATED");
    expect(displayStatus({ ...base, challengeIssued: true })).toBe("AUTHENTICATING");
    expect(displayStatus({ ...base, authenticated: true, challengeIssued: true })).toBe("AUTHORISED");
    expect(displayStatus({ ...base, state: "SUCCEEDED", authenticated: true })).toBe("CAPTURED");
    expect(displayStatus({ ...base, state: "SUCCEEDED", authenticated: true, reversed: true })).toBe(
      "REFUNDED",
    );
    expect(displayStatus({ ...base, state: "FAILED" })).toBe("FAILED");
  });
  it("US-34: a pending attempt whose session is no longer live shows as Failed (session expired)", () => {
    expect(displayStatus({ ...base, sessionLive: false })).toBe("FAILED");
    expect(displayStatus({ ...base, sessionLive: false, challengeIssued: true })).toBe("FAILED");
  });
});

describe("PRD R4.4 challenge rules", () => {
  it("US-36: three minutes, three tries, 30 s resend, six digits", () => {
    expect(CHALLENGE_RULES.ttlSeconds).toBe(180);
    expect(CHALLENGE_RULES.tries).toBe(3);
    expect(CHALLENGE_RULES.resendSeconds).toBe(30);
    expect(CHALLENGE_RULES.codeLength).toBe(6);
    expect(CHALLENGE_RULES.codesPerHour).toBe(10);
  });
});

describe("PRD R4.5 and R4.2: DeluluPay IDs and real payment data", () => {
  it("US-37: a DeluluPay ID ends in @delulu; anything else is refused", () => {
    expect(parseDeluluPayId("  Aarav.K@Delulu ")).toEqual({ ok: true, id: "aarav.k@delulu" });
    for (const bad of ["aarav@okaxis", "aarav@upi", "aarav", "@delulu", "a b@delulu", "9876543210@ybl"]) {
      expect(parseDeluluPayId(bad).ok, bad).toBe(false);
    }
  });

  it("US-37: pasting a card number, a real UPI handle, a CVV or an expiry into any checkout field is rejected", () => {
    const real = [
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "4111111111111111",
      "0420 0012 3456 7890", // even a game-shaped 16-digit number is never typed
      "5500005555555559",
      "name@okaxis",
      "9876543210@ybl",
      "someone@paytm",
      "cvv 123",
      "CVV: 4321",
      "exp 12/27",
      "expiry 08/2029",
      "my pin is 1234",
      "password hunter2",
    ];
    for (const text of real) expect(looksLikeRealPaymentData(text), text).toBe(true);
  });

  it("US-37: a dated coupon code is not mistaken for an expiry, while card-like runs and real patterns still are", () => {
    for (const ok of ["SAVE-10-25", "SAVE1025", "FLAT-12-24", "WINTER 10-25"]) {
      expect(looksLikeRealPaymentData(ok), ok).toBe(false);
    }
    for (const bad of [
      "12-27",
      "08-2029",
      "12/27",
      "SAVE 12/27",
      "4111-1111-1111-1111",
      "cvv123",
      "PIN 1234",
    ]) {
      expect(looksLikeRealPaymentData(bad), bad).toBe(true);
    }
  });

  it("US-37: ordinary codes and a DeluluPay ID are not flagged", () => {
    for (const ok of ["WELCOME10", "SAVE-20", "diwali2026", "aarav@delulu", "HOLI 25"]) {
      expect(looksLikeRealPaymentData(ok), ok).toBe(false);
    }
  });

  it("US-37 (property): any run of 13 to 19 digits, however separated, is flagged", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 13, maxLength: 19 }),
        fc.constantFrom("", " ", "-", ".", "  "),
        (digits, sep) => {
          expect(looksLikeRealPaymentData(digits.join(sep))).toBe(true);
        },
      ),
    );
  });
});

describe("PRD R4.6 test scenarios", () => {
  it("every scenario has one reserved DeluluPay ID that maps back to it", () => {
    expect(PAYMENT_SCENARIOS.length).toBe(Object.keys(TEST_DELULUPAY_IDS).length);
    for (const scenario of PAYMENT_SCENARIOS) {
      const id = TEST_DELULUPAY_IDS[scenario];
      expect(parseDeluluPayId(id).ok).toBe(true);
      expect(reservedScenarioOf(id)).toBe(scenario);
    }
    expect(reservedScenarioOf("aarav@delulu")).toBeNull();
  });
  it("lists the four methods of R4.2", () => {
    expect([...PAYMENT_METHODS].sort()).toEqual(["BALANCE", "CARD", "DELULUPAY_ID", "NET_BANKING"]);
  });
});
