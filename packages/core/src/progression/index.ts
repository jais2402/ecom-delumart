/**
 * Progression rules (LLD §5.8). Pure evaluators; callers supply the authoritative figures.
 */
import { DomainError } from "../errors/index";
import { CREATOR_THRESHOLD_PAISE, CRORE_RUPEES, PAISE_PER_RUPEE, type Paise } from "../money/index";

/** US-04: unlock when the wallet balance after a completed purchase is strictly below the threshold. */
export function shouldUnlockCreator(
  balanceAfterPaise: Paise,
  thresholdPaise: Paise = CREATOR_THRESHOLD_PAISE,
): boolean {
  return balanceAfterPaise < thresholdPaise;
}

export type CollectorLevelDef = { level: number; minItems: number; title: string };

/** US-31 thresholds and titles. */
export const COLLECTOR_LEVELS: readonly CollectorLevelDef[] = [
  { level: 1, minItems: 0, title: "New Arrival" },
  { level: 2, minItems: 5, title: "Curious Collector" },
  { level: 3, minItems: 15, title: "Curator" },
  { level: 4, minItems: 30, title: "Vault Builder" },
  { level: 5, minItems: 60, title: "Grand Collector" },
  { level: 6, minItems: 100, title: "Delulu Legend" },
];

export function collectorLevel(
  distinctItems: number,
  levels: readonly CollectorLevelDef[] = COLLECTOR_LEVELS,
): { level: number; title: string; nextAt: number | null } {
  if (!Number.isSafeInteger(distinctItems) || distinctItems < 0) {
    throw new DomainError("VALIDATION_FAILED", "distinct item count must be a non-negative integer");
  }
  let idx = 0;
  levels.forEach((l, i) => {
    if (distinctItems >= l.minItems) idx = i;
  });
  const current = levels[idx];
  if (!current) throw new DomainError("VALIDATION_FAILED", "no collector levels configured");
  return { level: current.level, title: current.title, nextAt: levels[idx + 1]?.minItems ?? null };
}

export type BrandConfig = { minGrossPaise: Paise; minDistinctBuyers: number };
export const DEFAULT_BRAND_CONFIG: BrandConfig = {
  minGrossPaise: 10n * CRORE_RUPEES * PAISE_PER_RUPEE,
  minDistinctBuyers: 5,
};

/** US-20: ≥ ₹10 crore qualifying gross and ≥ 5 distinct eligible buyers. */
export function brandQualifies(
  input: { grossPaise: Paise; distinctEligibleBuyers: number },
  cfg: BrandConfig = DEFAULT_BRAND_CONFIG,
): boolean {
  return input.grossPaise >= cfg.minGrossPaise && input.distinctEligibleBuyers >= cfg.minDistinctBuyers;
}
