/**
 * The sale-price display rule (US-43 "was" price), in the lowest-prior-price form (EU Omnibus
 * style). The reference ("was") price shown beside a product's current price is the LOWEST price
 * the product was published at (a list price or a sale price, any version) during the
 * `lookbackDays` (30) before the current price took effect. It is shown only when
 *   - it is strictly above the current price, and
 *   - the product was published for at least `minHours` (24) within that window.
 * A product published for less than the window uses its whole published history. A period the
 * listing was hidden counts as no price: it neither sets the minimum nor breaks the minimum hours.
 * Because the lowest price counts, raising a price first and cutting it later never shows a
 * reference above the 30-day low.
 *
 * The database (core.reference_price, migration 0083) computes the same thing from
 * core.price_history and core.listing_hide; the property tests hold the two together. Pure: the
 * caller supplies the price history (in the order it was recorded) and the time; no clock is read.
 *
 * Consecutive entries at the same price (a revision that kept the price) are one continuous run;
 * "the current price took effect" is the start of the current run.
 */
import { DomainError } from "../errors/index";
import type { Paise } from "../money/index";

export interface PricePoint {
  pricePaise: Paise;
  /** When this price took effect. */
  at: Date;
}

/** Defaults; the database reads the configuration keys of the same meaning (invariant 10). */
export const REFERENCE_PRICE_RULES = {
  /** Hours the product must have been published, within the window, before a reference may show. */
  minHours: 24,
  /** Days before the current price took effect that the lowest price is taken over. */
  lookbackDays: 30,
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function check(history: readonly PricePoint[]): void {
  for (let i = 0; i < history.length; i++) {
    const p = history[i] as PricePoint;
    if (p.pricePaise <= 0n || Number.isNaN(p.at.getTime())) {
      throw new DomainError("VALIDATION_FAILED", "a price history entry needs a positive price and a time");
    }
    const prev = history[i - 1];
    if (prev && prev.at.getTime() > p.at.getTime()) {
      throw new DomainError("VALIDATION_FAILED", "price history must be in the order it took effect");
    }
  }
}

/** Index of the first entry of the run of equal prices that ends at `end`. */
function runStart(history: readonly PricePoint[], end: number): number {
  const price = (history[end] as PricePoint).pricePaise;
  let i = end;
  while (i > 0 && (history[i - 1] as PricePoint).pricePaise === price) i--;
  return i;
}

/** A time the listing was off sale (hidden by moderation); `to` null while it still is. */
export interface OffSale {
  from: Date;
  to: Date | null;
}

export interface ReferencePriceOptions {
  minHours?: number;
  lookbackDays?: number;
  /** Hidden intervals: not published, so they carry no price and no published time. */
  offSale?: readonly OffSale[];
}

function rules(options: ReferencePriceOptions): { minMs: number; lookbackMs: number } {
  const minHours = options.minHours ?? REFERENCE_PRICE_RULES.minHours;
  const days = options.lookbackDays ?? REFERENCE_PRICE_RULES.lookbackDays;
  if (!Number.isSafeInteger(minHours) || minHours < 0) {
    throw new DomainError("VALIDATION_FAILED", "minHours is a non-negative whole number");
  }
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new DomainError("VALIDATION_FAILED", "lookbackDays is a whole number of at least 1");
  }
  return { minMs: minHours * HOUR_MS, lookbackMs: days * DAY_MS };
}

/**
 * The lowest published price and the published time (ms) in [end - lookback, end) over the entries
 * of `prior` (each lasting until the next entry, the last until `end`).
 */
function lowestPublished(
  prior: readonly PricePoint[],
  end: number,
  lookbackMs: number,
  offSale: readonly OffSale[],
): { low: Paise | null; ms: number } {
  const windowStart = end - lookbackMs;
  let low: Paise | null = null;
  let total = 0;
  for (let k = 0; k < prior.length; k++) {
    const row = prior[k] as PricePoint;
    const next = prior[k + 1];
    const a = Math.max(row.at.getTime(), windowStart);
    const b = Math.min(next ? next.at.getTime() : end, end);
    if (b <= a) continue;
    let published = b - a;
    for (const o of offSale) {
      const from = Math.max(o.from.getTime(), a);
      const to = Math.min(o.to === null ? end : o.to.getTime(), b);
      if (to > from) published -= to - from;
    }
    if (published <= 0) continue;
    total += published;
    if (low === null || row.pricePaise < low) low = row.pricePaise;
  }
  return { low, ms: total };
}

/** The "was" price to show beside the current (last) price, or null when none may be shown. */
export function referencePrice(
  history: readonly PricePoint[],
  options: ReferencePriceOptions = {},
): Paise | null {
  const { minMs, lookbackMs } = rules(options);
  check(history);
  if (history.length < 2) return null;
  const currentStart = runStart(history, history.length - 1);
  if (currentStart === 0) return null;
  const current = history[currentStart] as PricePoint;
  const { low, ms } = lowestPublished(
    history.slice(0, currentStart),
    current.at.getTime(),
    lookbackMs,
    options.offSale ?? [],
  );
  if (low === null || low <= (history.at(-1) as PricePoint).pricePaise || ms < minMs) return null;
  return low;
}

/**
 * What a new price set at `now` would be compared with: the lowest published price in the
 * lookback window up to `now` (the current price included), once the product has been published
 * for the minimum hours; null when no reference could show yet. A price strictly below the
 * ceiling set now shows exactly this reference; one at or above it shows none.
 */
export function referenceCeiling(
  history: readonly PricePoint[],
  now: Date,
  options: ReferencePriceOptions = {},
): Paise | null {
  const { minMs, lookbackMs } = rules(options);
  check(history);
  const { low, ms } = lowestPublished(history, now.getTime(), lookbackMs, options.offSale ?? []);
  return low !== null && ms >= minMs ? low : null;
}
