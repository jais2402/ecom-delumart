import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError, ERROR_CODES } from "../errors/index";
import {
  ADMIN_ACTION_KINDS,
  ADMIN_ACTION_RULES,
  announcementText,
  CONFIG_KEYS,
  configKeySpec,
  describeConfigValue,
  formatCountdown,
  readConfigValue,
  secondsUntil,
  storedConfigValue,
  validateConfigValue,
} from "./index";

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
  return "none";
};

const spec = (key: string) => {
  const s = configKeySpec(key);
  if (!s) throw new Error(`no spec for ${key}`);
  return s;
};

describe("US-60: the delayed-action rules (R16.6)", () => {
  it("the delay defaults to 24 hours and is clamped between an hour and a week", () => {
    expect(ADMIN_ACTION_RULES.delaySeconds).toBe(86_400);
    expect(ADMIN_ACTION_RULES.delayMinSeconds).toBe(3_600);
    expect(ADMIN_ACTION_RULES.delayMaxSeconds).toBe(604_800);
  });

  it("only known kinds exist; a platform coupon, minting or reversal is not one yet", () => {
    expect([...ADMIN_ACTION_KINDS]).toEqual(["config.set"]);
  });

  it("stable error codes for the queue exist", () => {
    for (const c of [
      "ADMIN_ACTION_UNKNOWN",
      "ADMIN_ACTION_LIMIT",
      "CONFIG_KEY_UNKNOWN",
      "CONFIG_VALUE_INVALID",
    ])
      expect(ERROR_CODES).toContain(c);
  });
});

describe("R7 Economy: the configuration allow-list", () => {
  it("every key has bounds, a default inside them and a path that spells its key", () => {
    const seen = new Set<string>();
    for (const k of CONFIG_KEYS) {
      expect(seen.has(k.key)).toBe(false);
      seen.add(k.key);
      expect(k.min).toBeGreaterThanOrEqual(0n);
      expect(k.max).toBeGreaterThan(k.min);
      expect(k.default).toBeGreaterThanOrEqual(k.min);
      expect(k.default).toBeLessThanOrEqual(k.max);
      expect(k.path.join(".")).toBe(k.key);
    }
    expect(CONFIG_KEYS.map((k) => k.key)).toEqual([
      "fee_percent",
      "delivery_fee_paise.STANDARD",
      "delivery_fee_paise.EXPRESS",
      "delivery_fee_paise.ZAP",
    ]);
  });

  it("a key outside the list is refused with CONFIG_KEY_UNKNOWN, including keys that would break the economy", () => {
    for (const key of [
      "starter_grant_paise",
      "price_min_paise",
      "analytics.place_min_visitors",
      "",
      "fee_percent ",
      "__proto__",
    ])
      expect(
        codeOf(() => validateConfigValue(key, "1")),
        key,
      ).toBe("CONFIG_KEY_UNKNOWN");
  });

  it("fees below zero or above the ceiling, and anything that is not a plain whole number, are CONFIG_VALUE_INVALID", () => {
    for (const bad of ["-1", "1.5", "1e3", "0x10", " 5", "5 ", "", "05", "٥", "NaN", "999999999999999999999"])
      expect(
        codeOf(() => validateConfigValue("fee_percent", bad)),
        bad,
      ).toBe("CONFIG_VALUE_INVALID");
    const fee = spec("fee_percent");
    expect(codeOf(() => validateConfigValue("fee_percent", String(fee.max + 1n)))).toBe(
      "CONFIG_VALUE_INVALID",
    );
    expect(codeOf(() => validateConfigValue("fee_percent", String(fee.max)))).toBe("none");
    expect(codeOf(() => validateConfigValue("fee_percent", "0"))).toBe("none");
  });

  it("property: a value is accepted exactly when it is a canonical whole number within the key's bounds", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CONFIG_KEYS), fc.bigInt({ min: -5n, max: 2n ** 70n }), (k, n) => {
        const accepted = codeOf(() => validateConfigValue(k.key, n.toString())) === "none";
        expect(accepted).toBe(n >= k.min && n <= k.max);
      }),
    );
  });

  it("invariant 1: money is stored as a decimal string and whole numbers as numbers; nothing is a float", () => {
    expect(storedConfigValue(spec("delivery_fee_paise.ZAP"), 5_000_000n)).toBe("5000000");
    expect(storedConfigValue(spec("fee_percent"), 7n)).toBe(7);
  });

  it("reads a current value the way the database does: the stored value, or the default when absent or malformed", () => {
    const fee = spec("fee_percent");
    const zap = spec("delivery_fee_paise.ZAP");
    expect(readConfigValue({}, fee)).toBe(5n);
    expect(readConfigValue({ fee_percent: 9 }, fee)).toBe(9n);
    expect(readConfigValue({ fee_percent: "9" }, fee)).toBe(9n);
    expect(readConfigValue({ fee_percent: 9.5 }, fee)).toBe(5n);
    expect(readConfigValue({ fee_percent: "abc" }, fee)).toBe(5n);
    expect(readConfigValue({ delivery_fee_paise: { ZAP: "6000000" } }, zap)).toBe(6_000_000n);
    expect(readConfigValue({ delivery_fee_paise: { ZAP: 6000000 } }, zap)).toBe(zap.default);
    expect(readConfigValue(null, zap)).toBe(zap.default);
  });

  it("describes values for people: a percent and a rupee amount", () => {
    expect(describeConfigValue(spec("fee_percent"), 5n)).toBe("5%");
    expect(describeConfigValue(spec("delivery_fee_paise.STANDARD"), 120_000n)).toBe("₹1,200");
  });

  it("the public announcement names the setting and the new value, never a reason or a person", () => {
    expect(announcementText("fee_percent", "6")).toBe("The marketplace fee is now 6% on new orders.");
    expect(announcementText("delivery_fee_paise.EXPRESS", "1200000")).toContain("₹12,000");
    expect(announcementText("nonsense", "1")).toBe("A store setting changed for new orders.");
  });
});

describe("US-60: the countdown", () => {
  it("counts whole seconds up to the execute-after time and never below zero", () => {
    expect(secondsUntil("2026-01-02T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z"))).toBe(86_400);
    expect(secondsUntil("2026-01-02T00:00:00.000Z", Date.parse("2026-01-03T00:00:00.000Z"))).toBe(0);
    expect(secondsUntil("not a date", 0)).toBe(0);
  });

  it("formats it for people", () => {
    expect(formatCountdown(86_400)).toBe("24 h 0 min");
    expect(formatCountdown(3_661)).toBe("1 h 1 min");
    expect(formatCountdown(59)).toBe("under a minute");
    expect(formatCountdown(0)).toBe("due now");
  });
});
