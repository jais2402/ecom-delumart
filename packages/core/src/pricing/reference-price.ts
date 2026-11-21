/**
 * The sale-price display rule (US-43 "was" price). A reference price may be shown next to a
 * product's current price only when that reference was the product's actual published price for
 * at least `minHours` (24) continuous hours immediately before the current price took effect, and
 * the current price is lower. A price increase never shows a reference. Pure: the caller supplies
 * the price history (core.price_history, in the order it was recorded); no clock is read.
 *
 * Consecutive entries at the same price (a revision that kept the price) are one continuous run.
 */
import { DomainError } from "../errors/index";
import type { Paise } from "../money/index";

export interface PricePoint {
  pricePaise: Paise;
  /** When this price took effect. */
  at: Date;
}

export const REFERENCE_PRICE_RULES = {
  /** Hours the earlier price must have been live, without interruption, right before the change. */
  minHours: 24,
} as const;

const HOUR_MS = 3_600_000;

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
  /** Hidden intervals: the earlier price was not "published" while the listing was hidden. */
  offSale?: readonly OffSale[];
}

/** The "was" price to show beside the current (last) price, or null when none may be shown. */
export function referencePrice(
  history: readonly PricePoint[],
  options: ReferencePriceOptions = {},
): Paise | null {
  const minHours = options.minHours ?? REFERENCE_PRICE_RULES.minHours;
  if (!Number.isSafeInteger(minHours) || minHours < 0) {
    throw new DomainError("VALIDATION_FAILED", "minHours is a non-negative whole number");
  }
  check(history);
  if (history.length < 2) return null;
  const currentStart = runStart(history, history.length - 1);
  if (currentStart === 0) return null;
  const current = history[currentStart] as PricePoint;
  const previousStart = runStart(history, currentStart - 1);
  const previous = history[previousStart] as PricePoint;
  if (previous.pricePaise <= current.pricePaise) return null;
  const from = previous.at.getTime();
  const to = current.at.getTime();
  if (to - from < minHours * HOUR_MS) return null;
  // continuously published: no hidden interval overlaps [from, to)
  const interrupted = (options.offSale ?? []).some(
    (o) => o.from.getTime() < to && (o.to === null || o.to.getTime() > from),
  );
  return interrupted ? null : previous.pricePaise;
}
