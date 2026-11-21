import "./server-only";
import { DomainError, rupeesToPaise } from "@delulu/core";
import type { CouponInput } from "@delulu/db/runtime";
import { z } from "zod";

/**
 * The studio's coupon request: `value` is the whole percent for PERCENT and whole rupees for FLAT;
 * the minimum spend is in whole rupees. The database checks every term again (percent range from
 * configuration, a public code of 4-16 letters or digits, a window that ends in the future, the
 * five-active limit) and generates a private coupon's code.
 */
const whole = z.number().int();

export const couponBody = z.strictObject({
  kind: z.enum(["PERCENT", "FLAT"]),
  value: whole.min(1).max(1_000_000_000),
  minSpendRupees: whole.min(0).max(1_000_000_000).optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  maxRedemptions: whole.min(1).max(1_000_000).optional(),
  isPublic: z.boolean(),
  publicCode: z.string().max(32).optional(),
});

export function checkCoupon(b: z.infer<typeof couponBody>): CouponInput {
  if (b.isPublic !== (b.publicCode !== undefined)) {
    throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", {
      reasons: [{ field: "publicCode", code: b.isPublic ? "REQUIRED" : "NOT_ALLOWED" }],
    });
  }
  return {
    kind: b.kind,
    value: b.kind === "PERCENT" ? BigInt(b.value) : rupeesToPaise(b.value),
    minSpendPaise: b.minSpendRupees === undefined ? 0n : rupeesToPaise(b.minSpendRupees),
    startsAt: b.startsAt === undefined ? null : new Date(b.startsAt),
    endsAt: b.endsAt === undefined ? null : new Date(b.endsAt),
    maxRedemptions: b.maxRedemptions ?? null,
    isPublic: b.isPublic,
    publicCode: b.publicCode ?? null,
  };
}

export const couponStatusBody = z.strictObject({ status: z.enum(["ACTIVE", "PAUSED", "ENDED"]) });
