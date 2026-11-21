import {
  DEFAULT_PRICING_CONFIG,
  formatInrCompact,
  formatInrExact,
  LISTING_RULES,
  PAISE_PER_RUPEE,
} from "@delulu/core";

export type ListingMode = "STANDARD_STOCKED" | "EXCLUSIVE";

/** What the editor holds. Numbers the person types stay as text until they are checked. */
export type ListingFormValues = {
  name: string;
  hook: string;
  description: string;
  category: string;
  templateId: number;
  altText: string;
  priceRupees: string;
  inventoryMode: ListingMode;
  quantity: string;
  offersExpress: boolean;
  freeStandardDelivery: boolean;
};

export type ListingField = keyof ListingFormValues;

const chars = (text: string) => [...text.trim()].length;

/** Whole rupees from what was typed (commas and spaces allowed), or null when it is not a whole number. */
export function parseRupees(text: string): bigint | null {
  const cleaned = text.replace(/[,\s]/g, "");
  if (!/^\d{1,12}$/.test(cleaned)) return null;
  return BigInt(cleaned);
}

/** "₹2,50,000 = ₹2.5 lakh", or just the grouped amount below a lakh; null when there is nothing to read. */
export function priceReading(text: string): string | null {
  const rupees = parseRupees(text);
  if (rupees === null) return null;
  const paise = rupees * PAISE_PER_RUPEE;
  const exact = formatInrExact(paise);
  const compact = formatInrCompact(paise);
  return exact === compact ? exact : `${exact} = ${compact}`;
}

/** The marketplace fee and what the seller keeps, in paise (the same whole-number rounding as the pricing function). */
export function netOfFee(rupees: bigint, feePercent: number = DEFAULT_PRICING_CONFIG.feePercent) {
  const price = rupees * PAISE_PER_RUPEE;
  const fee = (price * BigInt(feePercent)) / 100n;
  return { pricePaise: price, feePaise: fee, netPaise: price - fee };
}

export function parseQuantity(text: string): number | null {
  const cleaned = text.trim();
  if (!/^\d{1,5}$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function suggestedAltText(name: string): string {
  const trimmed = name.trim();
  return trimmed ? `Illustration of ${trimmed}` : "";
}

/** One plain sentence per problem, per field. Empty object when everything is fine. */
export function listingProblems(values: ListingFormValues): Partial<Record<ListingField, string>> {
  const r = LISTING_RULES;
  const out: Partial<Record<ListingField, string>> = {};
  const nameLength = chars(values.name);
  if (nameLength < r.name.min) out.name = `Use at least ${r.name.min} characters.`;
  else if (nameLength > r.name.max) out.name = `Use ${r.name.max} characters or fewer.`;
  else if (/\p{Cc}/u.test(values.name)) out.name = "Remove special control characters.";
  if (chars(values.hook) > r.hook.max) out.hook = `Use ${r.hook.max} characters or fewer.`;
  else if (/\p{Cc}/u.test(values.hook)) out.hook = "Remove special control characters.";
  const descriptionLength = chars(values.description);
  if (descriptionLength < r.description.min)
    out.description = `Use at least ${r.description.min} characters.`;
  else if (descriptionLength > r.description.max)
    out.description = `Use ${r.description.max} characters or fewer.`;
  else if (/\p{Cc}/u.test(values.description.replaceAll("\n", "")))
    out.description = "Remove special control characters.";
  if (chars(values.altText) > r.altText.max) out.altText = `Use ${r.altText.max} characters or fewer.`;
  if (!values.category) out.category = "Pick a category.";
  const price = parseRupees(values.priceRupees);
  const min = BigInt(r.priceRupees.min);
  const max = BigInt(r.priceRupees.max);
  if (price === null) out.priceRupees = "Enter a whole number of rupees, like 2500.";
  else if (price < min || price > max)
    out.priceRupees = `Price must be between ${formatInrExact(min * PAISE_PER_RUPEE)} and ${formatInrCompact(max * PAISE_PER_RUPEE)}.`;
  const quantity = parseQuantity(values.quantity);
  if (quantity === null || quantity < r.quantity.min || quantity > r.quantity.max)
    out.quantity = `Enter a whole number from ${r.quantity.min} to ${r.quantity.max}.`;
  return out;
}
