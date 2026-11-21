import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "./rate-limit";

describe("fixed-window rate limiter", () => {
  it("allows `limit` hits per key per window, then refuses with the time left", () => {
    let now = 120_000;
    const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }, () => now);
    expect([1, 2, 3].map(() => limiter.hit("a").allowed)).toEqual([true, true, true]);
    const refused = limiter.hit("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(60_000);
    expect(limiter.hit("b").allowed).toBe(true);
    now += 60_000;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("never allows more than `limit` hits in one window (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 5_000 })),
        (limit, gaps) => {
          let now = 0;
          const limiter = new FixedWindowLimiter({ limit, windowMs: 10_000 }, () => now);
          const allowedPerWindow = new Map<number, number>();
          for (const gap of gaps) {
            now += gap;
            if (limiter.hit("k").allowed) {
              const w = Math.floor(now / 10_000);
              allowedPerWindow.set(w, (allowedPerWindow.get(w) ?? 0) + 1);
            }
          }
          return [...allowedPerWindow.values()].every((n) => n <= limit);
        },
      ),
    );
  });

  it("sweeps expired windows so memory stays bounded", () => {
    let now = 0;
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 10 }, () => now, 5);
    for (let i = 0; i < 20; i++) {
      limiter.hit(`k${i}`);
      now += 20;
    }
    expect(limiter.size).toBeLessThanOrEqual(6);
  });
});
