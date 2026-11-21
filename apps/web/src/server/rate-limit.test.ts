import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RATE_RULES, retryAfterSeconds } from "./rate-limit";

describe("database rate limit rules (fifth security review)", () => {
  it("every rule has its own scope the database accepts, a window of at most a day and a positive limit", () => {
    const rules = Object.values(RATE_RULES);
    expect(new Set(rules.map((r) => r.scope)).size).toBe(rules.length);
    for (const r of rules) {
      expect(r.scope).toMatch(/^[a-z][a-z0-9_.:-]{0,63}$/);
      expect(r.windowSeconds).toBeGreaterThanOrEqual(1);
      expect(r.windowSeconds).toBeLessThanOrEqual(86_400);
      expect(r.limit).toBeGreaterThanOrEqual(1);
    }
  });

  it("LLD §11.2: coupon codes 10 / hour / account; purchase attempts (checkout, pay) 10 / minute / account", () => {
    expect(RATE_RULES.couponActor).toMatchObject({ by: "actor", limit: 10, windowSeconds: 3_600 });
    expect(RATE_RULES.checkoutActor).toMatchObject({ by: "actor", limit: 10, windowSeconds: 60 });
    expect(RATE_RULES.payActor).toMatchObject({ by: "actor", limit: 10, windowSeconds: 60 });
    expect(RATE_RULES.phoneCodeActor).toMatchObject({ by: "actor", limit: 5, windowSeconds: 86_400 });
    expect(RATE_RULES.signInAddress.by).toBe("address");
  });

  it("retry-after is the rest of the fixed window, between 1 s and the window (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 86_400 }),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (w, now) => {
          const s = retryAfterSeconds(w, now);
          expect(s).toBeGreaterThanOrEqual(1);
          expect(s).toBeLessThanOrEqual(w);
          // the window ends at the next multiple of w seconds
          expect(Math.ceil((now + 1) / 1000 / w) * w * 1000 - now).toBeLessThanOrEqual(s * 1000 + 1000);
        },
      ),
    );
  });
});
