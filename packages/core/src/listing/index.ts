/**
 * Player listings (US-08): the shape rules of a listing's fields, the price and quantity rules,
 * and the text screening of a listing. Pure.
 *
 * The web server checks shapes and lengths before calling the database (which checks them again,
 * migration 0036); it does NOT screen listing text at write time. Screening is done by the job
 * runner (apps/web/src/server/jobs.ts) with `screenListing` over the name, hook, description and
 * alt text of the pinned revision, and its verdict is applied by the jobs role only.
 */
import { type ScreenResult, screenText } from "../screening/index";

/** Product rules of a listing (mirrored by core.listing_text_problem, migration 0036). */
export const LISTING_RULES = {
  name: { min: 3, max: 80 },
  hook: { max: 140 },
  description: { min: 20, max: 1000 },
  altText: { max: 300 },
  /** The template illustration id, the same field seed products use. */
  templateId: { min: 0, max: 359 },
  /** Whole rupees: ₹100 to ₹100 crore (configuration price_min_paise / price_max_paise). */
  priceRupees: { min: 100, max: 1_000_000_000 },
  /** Units of a STANDARD_STOCKED listing or the supply of an EXCLUSIVE one (listing_quantity_max). */
  quantity: { min: 1, max: 1000 },
} as const;

export type ListingField = "name" | "hook" | "description" | "altText" | "templateId";
export type ListingProblemCode =
  | "REQUIRED"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "CONTROL_CHARACTERS"
  | "OUT_OF_RANGE";

export interface ListingProblem {
  field: ListingField;
  code: ListingProblemCode;
}

export interface ListingTextInput {
  name?: string | undefined;
  hook?: string | null | undefined;
  description?: string | undefined;
  altText?: string | undefined;
  templateId?: number | undefined;
}

const chars = (s: string): number => [...s.trim()].length;
/** Any control character. */
const CONTROL = (s: string): boolean => /\p{Cc}/u.test(s);
/** Control characters other than a line break. */
const CONTROL_BUT_NEWLINE = (s: string): boolean => /\p{Cc}/u.test(s.replaceAll("\n", ""));

function lengthProblem(
  field: ListingField,
  value: string,
  min: number,
  max: number,
  control: (s: string) => boolean,
): ListingProblem | null {
  const n = chars(value);
  if (n < min) return { field, code: "TOO_SHORT" };
  if (n > max) return { field, code: "TOO_LONG" };
  if (control(value)) return { field, code: "CONTROL_CHARACTERS" };
  return null;
}

/**
 * The problems of the fields present in `input`, at most one per field, in a fixed field order.
 * With `required`, a missing name, description or template id is REQUIRED (a new draft).
 */
export function checkListingFields(
  input: ListingTextInput,
  options: { required: boolean } = { required: false },
): ListingProblem[] {
  const out: ListingProblem[] = [];
  const push = (p: ListingProblem | null) => {
    if (p) out.push(p);
  };
  const r = LISTING_RULES;
  if (input.name !== undefined) push(lengthProblem("name", input.name, r.name.min, r.name.max, CONTROL));
  else if (options.required) out.push({ field: "name", code: "REQUIRED" });
  if (input.hook !== undefined && input.hook !== null) {
    push(lengthProblem("hook", input.hook, 0, r.hook.max, CONTROL));
  }
  if (input.description !== undefined) {
    push(
      lengthProblem(
        "description",
        input.description,
        r.description.min,
        r.description.max,
        CONTROL_BUT_NEWLINE,
      ),
    );
  } else if (options.required) out.push({ field: "description", code: "REQUIRED" });
  if (input.altText !== undefined) push(lengthProblem("altText", input.altText, 0, r.altText.max, CONTROL));
  if (input.templateId !== undefined) {
    const t = input.templateId;
    if (!Number.isInteger(t) || t < r.templateId.min || t > r.templateId.max) {
      out.push({ field: "templateId", code: "OUT_OF_RANGE" });
    }
  } else if (options.required) out.push({ field: "templateId", code: "REQUIRED" });
  return out;
}

/** Whole rupees within the listing price range. */
export function checkPriceRupees(rupees: number): boolean {
  return (
    Number.isSafeInteger(rupees) &&
    rupees >= LISTING_RULES.priceRupees.min &&
    rupees <= LISTING_RULES.priceRupees.max
  );
}

/** Exact paise for whole rupees (invariant 1: bigint, never float arithmetic). */
export function rupeesToPaise(rupees: number): bigint {
  if (!Number.isSafeInteger(rupees)) throw new RangeError("rupees must be a whole number");
  return BigInt(rupees) * 100n;
}

export function checkQuantity(quantity: number): boolean {
  return (
    Number.isSafeInteger(quantity) &&
    quantity >= LISTING_RULES.quantity.min &&
    quantity <= LISTING_RULES.quantity.max
  );
}

export interface ListingScreenFields {
  name: string;
  hook: string | null;
  description: string;
  altText: string;
}

/** The screening of a listing revision: its name, hook, description and alt text. */
export function screenListing(fields: ListingScreenFields): ScreenResult {
  return screenText({
    name: fields.name,
    hook: fields.hook ?? "",
    description: fields.description,
    altText: fields.altText,
  });
}
