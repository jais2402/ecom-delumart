import { STARTING_GRANT_PAISE } from "@delulu/core";

/** Decimal places of the percentage; the smallest price (₹100) is 0.00001% of the starting grant. */
const DECIMALS = 5;
const PERCENT = 100n;

/**
 * A price as a share of the starting balance, as plain text such as "0.00088%". Integer maths on
 * paise only (CLAUDE.md invariant 1): the share is floored to DECIMALS places, never rounded up,
 * and the result is empty for a grant that is not positive.
 */
export function shareOfStartingBalance(
  pricePaise: bigint,
  grantPaise: bigint = STARTING_GRANT_PAISE,
): string {
  if (grantPaise <= 0n || pricePaise < 0n) return "";
  const scale = 10n ** BigInt(DECIMALS);
  const units = (pricePaise * PERCENT * scale) / grantPaise;
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  const text = fraction === "" ? `${whole}` : `${whole}.${fraction}`;
  return `${text}%`;
}
