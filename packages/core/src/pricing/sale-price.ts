/**
 * Sale price rules (PRD R6.2, US-43). Pure: the database commands apply the same rules; this is the
 * reference the property tests and the web layer's early checks use.
 *
 * A sale is a lower price than the list price. The list price is what the product sold for before
 * the sale and what it returns to when the sale ends. The sale price is the product's price while
 * the sale lasts: every purchase, fee and quote uses it (it is the list price of the pricing
 * function, so the marketplace fee is on the price the seller is actually selling at, R6.6).
 */
import { DomainError } from "../errors/index";
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, PAISE_PER_RUPEE, type Paise } from "../money/index";
import { type PricePoint, type ReferencePriceOptions, referencePrice } from "./reference-price";

export type SaleProblem = "OUT_OF_RANGE" | "NOT_LOWER";

/** Whether `salePaise` may be a sale price for a product listed at `listPaise`; null when it may. */
export function salePriceProblem(listPaise: Paise, salePaise: Paise): SaleProblem | null {
  if (salePaise < MIN_PRICE_PAISE || salePaise > MAX_PRICE_PAISE || salePaise % PAISE_PER_RUPEE !== 0n) {
    return "OUT_OF_RANGE";
  }
  return salePaise < listPaise ? null : "NOT_LOWER";
}

/**
 * The reference ("was") price for the history, or REFERENCE_PRICE_INELIGIBLE when the seller asked
 * for one and the earlier price was not the actual published price for the required hours.
 */
export function requireReferencePrice(
  history: readonly PricePoint[],
  options: ReferencePriceOptions = {},
): Paise {
  const reference = referencePrice(history, options);
  if (reference === null) {
    throw new DomainError(
      "REFERENCE_PRICE_INELIGIBLE",
      "The earlier price was not the published price for long enough to show it.",
    );
  }
  return reference;
}
