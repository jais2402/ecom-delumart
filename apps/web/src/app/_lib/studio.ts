import type { ListingField, ListingFormValues, ListingStatusValue } from "@delulu/ui";
import { CATEGORIES } from "../../data/seed-catalog";
import { ApiError } from "./api";
import { parsePaise } from "./money";
import { reasonText, sellingErrorText } from "./selling";

/** Types of the studio and moderation API bodies (money fields are decimal strings). */
export type NextAction =
  | "SUBMIT"
  | "ALLOCATE_STOCK"
  | "WAIT_FOR_SCREENING"
  | "WAIT_FOR_REVIEW"
  | "EDIT_AND_RESUBMIT"
  | "HIDDEN_BY_MODERATION"
  | "WAIT_FOR_REVISION"
  | "RESTOCK"
  | "NONE";

export interface ListingVersion {
  id: string;
  revision: number;
  name: string;
  hook: string | null;
  description: string;
  altText: string;
  templateId: number;
  pricePaise: string;
  createdAt: string;
}

export interface FieldCode {
  field: string;
  code: string;
}

export interface Listing {
  id: string;
  status: ListingStatusValue;
  category: string;
  inventoryMode: "STANDARD_STOCKED" | "EXCLUSIVE";
  quantity: number | null;
  offersExpress: boolean;
  freeStandardDelivery: boolean;
  approvedNeedsStock: boolean;
  createdAt: string;
  updatedAt: string | null;
  publishedAt: string | null;
  current: ListingVersion | null;
  live: ListingVersion | null;
  pending: {
    submissionId: string;
    kind: string;
    state: string;
    submittedAt: string;
    reasons: FieldCode[];
    version: ListingVersion;
  } | null;
  lastDecision: {
    kind: string;
    state: string;
    versionId: string;
    reasons: FieldCode[];
    reason: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
  } | null;
  moderationReason: string | null;
  stock: { available: number; issued: number; retired: number };
  edition: { supply: number; issued: number } | null;
  nextAction: NextAction;
  /** The sale state (migration 0081); money fields are decimal strings. */
  sale: {
    active: boolean;
    listPaise: string | null;
    salePaise: string | null;
    startedAt: string | null;
    referencePaise: string | null;
    canShowReference: boolean;
  };
}

export interface ListingDetail extends Listing {
  /** The latest appeal of this listing, if any. */
  appeal: { id: string; status: "OPEN" | "UPHELD" | "DENIED"; createdAt: string } | null;
  /** Rejected or hidden by moderation, and not yet appealed. */
  appealable: boolean;
  priceHistory: {
    versionId: string;
    pricePaise: string;
    previousPaise: string | null;
    reason: string | null;
    changedAt: string;
  }[];
}

export interface ListingPage {
  items: Listing[];
  nextCursor: string | null;
}

export interface ModerationItem {
  submissionId: string;
  productId: string;
  versionId: string;
  kind: string;
  submittedAt: string;
  reasons: FieldCode[];
  store: { handle: string; displayName: string };
  category: string;
  inventoryMode: "STANDARD_STOCKED" | "EXCLUSIVE";
  productStatus: string;
  version: ListingVersion;
}

export interface ModerationPage {
  items: ModerationItem[];
  nextCursor: string | null;
  appeals: unknown[];
}

export interface WarehouseSummary {
  id: string;
  kind: string;
  capacity: number;
  used: number;
  zapHub: boolean;
}

export const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name }));

export function categoryLabel(slug: string): string {
  return CATEGORY_OPTIONS.find((c) => c.slug === slug)?.name ?? slug;
}

/** Caps from the brief (configuration keys listing_draft_max and listing_published_max). */
export const LISTING_CAPS = { drafts: 20, published: 10 } as const;

/** Statuses that count against the draft cap: private, not yet live. */
export const DRAFT_STATUSES: readonly ListingStatusValue[] = [
  "DRAFT",
  "SCREENING",
  "NEEDS_REVIEW",
  "REJECTED",
];

export function countCaps(items: readonly Listing[]): { drafts: number; published: number } {
  return {
    drafts: items.filter((l) => DRAFT_STATUSES.includes(l.status)).length,
    published: items.filter((l) => l.status === "PUBLISHED").length,
  };
}

export const EMPTY_VALUES: ListingFormValues = {
  name: "",
  hook: "",
  description: "",
  category: "",
  templateId: 200,
  altText: "",
  priceRupees: "",
  inventoryMode: "STANDARD_STOCKED",
  quantity: "1",
  offersExpress: false,
  freeStandardDelivery: false,
};

/** Whole rupees of a paise string, as digits. */
export function rupeesText(paise: string): string {
  return (parsePaise(paise) / 100n).toString();
}

/** The values to edit: a waiting revision if there is one, else the current version. */
export function valuesFromListing(l: Listing): ListingFormValues {
  const v = l.pending?.version ?? l.current;
  if (!v) return { ...EMPTY_VALUES, category: l.category, inventoryMode: l.inventoryMode };
  return {
    name: v.name,
    hook: v.hook ?? "",
    description: v.description,
    category: l.category,
    templateId: v.templateId,
    altText: v.altText,
    priceRupees: rupeesText(v.pricePaise),
    inventoryMode: l.inventoryMode,
    quantity: String(l.edition?.supply ?? l.quantity ?? 1),
    offersExpress: l.offersExpress,
    freeStandardDelivery: l.freeStandardDelivery,
  };
}

/** The request body for a draft: whole rupees and quantity as numbers (the form already checked them). */
export function draftBody(values: ListingFormValues) {
  return {
    name: values.name.trim(),
    ...(values.hook.trim() ? { hook: values.hook.trim() } : { hook: null }),
    description: values.description.trim(),
    category: values.category,
    templateId: values.templateId,
    altText: values.altText.trim(),
    priceRupees: Number(values.priceRupees.replace(/[,\s]/g, "")),
    inventoryMode: values.inventoryMode,
    quantity: Number(values.quantity.trim()),
    offersExpress: values.offersExpress,
    freeStandardDelivery: values.freeStandardDelivery,
  };
}

export function revisionBody(values: ListingFormValues) {
  return {
    name: values.name.trim(),
    hook: values.hook.trim() ? values.hook.trim() : null,
    description: values.description.trim(),
    altText: values.altText.trim(),
    templateId: values.templateId,
  };
}

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  hook: "Tagline",
  description: "Description",
  altText: "Picture description",
  templateId: "Template",
  priceRupees: "Price",
  quantity: "Quantity",
};

const FORMAT_TEXT: Record<string, string> = {
  REQUIRED: "This is needed.",
  TOO_SHORT: "This is too short.",
  TOO_LONG: "This is too long.",
  OUT_OF_RANGE: "This is outside the allowed range.",
};

/** One plain sentence for a field problem or a screening reason. It never repeats the submitted text. */
export function listingReasonText(code: string, field: string): string {
  return FORMAT_TEXT[code] ?? reasonText(field, code);
}

/** "Name: This wording sounds official…" per reason, de-duplicated. */
export function reasonLines(reasons: readonly FieldCode[]): string[] {
  const out: string[] = [];
  for (const { field, code } of reasons) {
    const line = `${FIELD_LABEL[field] ?? "Listing"}: ${listingReasonText(code, field)}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The 422 details.reasons of a refused request, as messages per form field. */
export function listingFieldErrors(error: unknown): Partial<Record<ListingField, string[]>> {
  const out: Partial<Record<ListingField, string[]>> = {};
  if (!(error instanceof ApiError)) return out;
  const reasons = error.details.reasons;
  if (!Array.isArray(reasons)) return out;
  for (const entry of reasons) {
    if (typeof entry !== "object" || entry === null) continue;
    const { field, code } = entry as { field?: unknown; code?: unknown };
    if (typeof field !== "string" || typeof code !== "string") continue;
    const key = field as ListingField;
    const list = out[key] ?? [];
    const text = listingReasonText(code, field);
    if (!list.includes(text)) list.push(text);
    out[key] = list;
  }
  return out;
}

const STUDIO_ERRORS: Record<string, string> = {
  DRAFT_LIMIT: "You have 20 drafts already. Delete or publish one before starting another.",
  PUBLISH_LIMIT: "Your shop has 10 published listings, the most it can have. Archive one first.",
  CAPACITY_EXCEEDED:
    "Your warehouse does not have that much free space. Lower the quantity or free up space.",
  NOT_EDITABLE: "This listing cannot be changed in its current state.",
  SUBMISSION_LIMIT: "Your shop has used today's submissions. Try again tomorrow.",
  PUBLICATION_PAUSED: "Publishing is paused for now. Nothing was lost. Try again later.",
  COMPANY_FEE_REQUIRED: "Your shop's setup fee has not been paid yet.",
  CREATOR_LOCKED: "Creator access is not open for you yet.",
  FORBIDDEN: "You do not have access to that.",
  RATE_LIMITED: "Too many tries in a short time. Wait a moment, then try again.",
  CONFLICT: "That change conflicts with the listing's current state. Reload and try again.",
  NOT_FOUND: "That listing was not found.",
};

export function studioErrorText(error: unknown): string {
  if (error instanceof ApiError && STUDIO_ERRORS[error.code]) return STUDIO_ERRORS[error.code] as string;
  return sellingErrorText(error);
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "FORBIDDEN" || error.status === 403);
}
