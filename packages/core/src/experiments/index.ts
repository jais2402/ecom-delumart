/**
 * Deterministic experiment assignment (LLD §5.8):
 * bucket = first 4 bytes of HMAC-SHA-256(salt, subjectId) mod 10000, mapped to a variant by cumulative weight.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { DomainError } from "../errors/index";

export const BUCKETS = 10_000;

export type Variant = { key: string; weight: number };

export type ExperimentConfig = {
  /** Upper bound on the summed weights, so `bucket × total` stays exact in a double. */
  maxTotalWeight: number;
};
export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = { maxTotalWeight: 1_000_000_000 };

export function bucketOf(salt: string, subjectId: string): number {
  const h = hmac(sha256, utf8ToBytes(salt), utf8ToBytes(subjectId));
  return new DataView(h.buffer, h.byteOffset, 4).getUint32(0, false) % BUCKETS;
}

/**
 * Weights are non-negative integers; they normally sum to 10000 (basis points). Any positive total up to
 * `cfg.maxTotalWeight` is accepted and scaled, so bucket b falls in variant i when
 * b × total < cumulative_i × 10000. A zero weight switches a variant off.
 */
export function assignVariant(
  input: {
    salt: string;
    subjectId: string;
    variants: readonly Variant[];
  },
  cfg: ExperimentConfig = DEFAULT_EXPERIMENT_CONFIG,
): string {
  const { variants } = input;
  if (variants.length === 0 || variants.some((v) => !Number.isSafeInteger(v.weight) || v.weight < 0)) {
    throw new DomainError("VALIDATION_FAILED", "variants need non-negative integer weights");
  }
  const total = variants.reduce((a, v) => a + v.weight, 0);
  if (total <= 0) throw new DomainError("VALIDATION_FAILED", "variant weights must sum to more than zero");
  if (!Number.isSafeInteger(total) || total > cfg.maxTotalWeight) {
    throw new DomainError("VALIDATION_FAILED", "variant weights sum to more than the allowed maximum", {
      maxTotalWeight: cfg.maxTotalWeight,
    });
  }
  const point = bucketOf(input.salt, input.subjectId) * total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.weight;
    if (point < cumulative * BUCKETS) return v.key;
  }
  // Unreachable: point < total × BUCKETS always.
  throw new DomainError("VALIDATION_FAILED", "variant assignment failed");
}
