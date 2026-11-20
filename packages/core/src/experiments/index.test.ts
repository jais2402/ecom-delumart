import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import { assignVariant, bucketOf } from "./index";

const variants = [
  { key: "control", weight: 5000 },
  { key: "treatment", weight: 5000 },
];

describe("assignVariant", () => {
  it("is stable for the same salt and subject (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.uuid(), (salt, subjectId) => {
        expect(assignVariant({ salt, subjectId, variants })).toBe(
          assignVariant({ salt, subjectId, variants }),
        );
      }),
    );
  });

  it("buckets are in 0..9999", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (salt, subjectId) => {
        const b = bucketOf(salt, subjectId);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(10_000);
      }),
    );
  });

  it("splits 10,000 subjects within tolerance of the weights", () => {
    const weighted = [
      { key: "a", weight: 7000 },
      { key: "b", weight: 2000 },
      { key: "c", weight: 1000 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10_000; i++) {
      const v = assignVariant({ salt: "exp-checkout-copy", subjectId: `user-${i}`, variants: weighted });
      counts[v] = (counts[v] ?? 0) + 1;
    }
    expect(Math.abs((counts.a ?? 0) - 7000)).toBeLessThan(250);
    expect(Math.abs((counts.b ?? 0) - 2000)).toBeLessThan(200);
    expect(Math.abs((counts.c ?? 0) - 1000)).toBeLessThan(150);
  });

  it("different salts give independent assignments", () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) {
      const s = `user-${i}`;
      if (
        assignVariant({ salt: "x", subjectId: s, variants }) ===
        assignVariant({ salt: "y", subjectId: s, variants })
      )
        same++;
    }
    expect(same).toBeGreaterThan(850);
    expect(same).toBeLessThan(1150);
  });

  it("a zero-weight variant is never chosen; a 100% variant always is", () => {
    for (let i = 0; i < 500; i++) {
      expect(
        assignVariant({
          salt: "s",
          subjectId: `u${i}`,
          variants: [
            { key: "off", weight: 0 },
            { key: "on", weight: 10_000 },
          ],
        }),
      ).toBe("on");
    }
  });

  it("rejects empty or non-positive weights", () => {
    expect(() => assignVariant({ salt: "s", subjectId: "u", variants: [] })).toThrow(DomainError);
    expect(() => assignVariant({ salt: "s", subjectId: "u", variants: [{ key: "a", weight: -1 }] })).toThrow(
      DomainError,
    );
  });
});
