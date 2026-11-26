import {
  HANDLE_RULES,
  STARTING_GRANT_PAISE,
  STORE_DESCRIPTION_MAX_CHARS,
  STORE_NAME_RULES,
} from "@delulu/core";
import type { ShopIdentityLimits } from "@delulu/ui";
import { ApiError } from "./api";

/** Types of the selling-side API bodies the screens read (money fields are decimal strings). */
export interface SavedItem {
  productId: string;
  savedAt: string;
  published: boolean;
  name: string;
  pricePaise: string;
  sellerName: string | null;
  available: boolean;
  templateId: number;
  altText: string;
}

export interface SavedPage {
  items: SavedItem[];
  nextCursor: string | null;
}

export interface PassportResponse {
  ruleVersion: string;
  steps: {
    quiz: { done: boolean; completedAt: string | null; failedAttempts: number };
    saves: { done: boolean; completedAt: string | null; count: number; required: number };
    concept: { done: boolean; completedAt: string | null; text: string | null };
  };
  completedAt: string | null;
  quiz: {
    ruleVersion: string;
    questions: { id: string; topic: string; prompt: string; options: { id: string; label: string }[] }[];
  };
}

export type PassportProgress = Omit<PassportResponse, "quiz">;

export interface CreatorAccessResponse {
  unlocked: boolean;
  source: "PURCHASE_THRESHOLD" | "ACHIEVEMENT" | null;
  unlockedAt: string | null;
  ruleVersion: string;
  routes: {
    spend: {
      balancePaise: string | null;
      thresholdPaise: string;
      reached: boolean;
      reachedAt: string | null;
    };
    passport: PassportProgress;
  };
}

export interface ReliefResponse {
  eligible: boolean;
  reason: "LIFETIME_LIMIT" | "CLAIMED_TODAY" | "BALANCE_TOO_HIGH" | null;
  claimsUsed: number;
  claimsMax: number;
  claimsRemaining: number;
  balancePaise: string | null;
  ceilingPaise: string;
  grantPaise: string;
  nextResetAt: string;
}

export interface CompanyQuoteResponse {
  sessionId: string;
  expiresAt: string;
  handle: string;
  displayName: string;
  description: string;
  feePaise: string;
  sponsorshipPaise: string;
  payablePaise: string;
  balancePaise: string;
  balanceAfterPaise: string | null;
  sufficient: boolean;
}

export interface CompanyReceiptResponse {
  companyId: string;
  handle: string;
  displayName: string;
  tier: string;
  warehouseId: string;
  feePaise: string;
  paidPaise: string;
  sponsorshipPaise: string;
  balanceAfterPaise: string;
  paymentReference: string;
  replayed: boolean;
}

export interface CompanyView {
  id: string;
  handle: string;
  displayName: string;
  description: string;
  tier: string;
  registeredAt: string;
  warehouses: {
    count: number;
    capacity: number;
    used: number;
    starter: { id: string; capacity: number; used: number } | null;
  };
}

export interface StoreResponse {
  handle: string;
  displayName: string;
  description: string;
  tier: string;
}

/** Where the balance started: creator-access progress is measured from here. */
export const STARTING_BALANCE_PAISE: bigint = STARTING_GRANT_PAISE;

/** The passport concept's length bounds (passport_v1). The API does not publish them; kept in step with the rules. */
export const CONCEPT_LIMITS = { minChars: 20, maxChars: 280 } as const;

export const SHOP_LIMITS: ShopIdentityLimits = {
  handleMin: HANDLE_RULES.minChars,
  handleMax: HANDLE_RULES.maxChars,
  nameMin: STORE_NAME_RULES.minChars,
  nameMax: STORE_NAME_RULES.maxChars,
  descriptionMax: STORE_DESCRIPTION_MAX_CHARS,
};

const SCREEN_TEXT: Record<string, string> = {
  LINK: "Remove web links and site names. Everything here stays inside DeluluMart.",
  EMAIL: "Remove email addresses.",
  PHONE: "Remove phone numbers and long runs of digits.",
  PAYMENT: "Remove anything about real payments, cards or bank details.",
  BLOCKED_TERM: "A word here is not allowed on DeluluMart. Try different wording.",
  OFFICIAL:
    "This wording sounds official and needs a review before it can be used. Try describing it differently.",
  BRAND:
    "This wording looks like a real brand and needs a review before it can be used. Try an invented name.",
  WATCH: "This wording needs a review before it can be used. Try describing it differently.",
  CAPS: "Too many capital letters. Use ordinary capitalisation.",
  CONTROL_CHARACTERS: "Remove special control characters. Line breaks are fine.",
  INVISIBLE: "Remove hidden or formatting characters (for example, text pasted from elsewhere).",
};

const FIELD_TEXT: Record<string, Record<string, string>> = {
  concept: {
    TOO_SHORT: `Write at least ${CONCEPT_LIMITS.minChars} characters.`,
    TOO_LONG: `Keep it to ${CONCEPT_LIMITS.maxChars} characters or fewer.`,
  },
  handle: {
    TOO_SHORT: `Use at least ${HANDLE_RULES.minChars} characters.`,
    TOO_LONG: `Use ${HANDLE_RULES.maxChars} characters or fewer.`,
    BAD_CHARACTERS: "Use only lowercase letters, digits and hyphens.",
    HYPHEN_EDGE: "Do not start or end with a hyphen.",
    DOUBLE_HYPHEN: "Do not use two hyphens in a row.",
    RESERVED: "That handle is reserved. Try another.",
  },
  displayName: {
    TOO_SHORT: `Use at least ${STORE_NAME_RULES.minChars} characters.`,
    TOO_LONG: `Use ${STORE_NAME_RULES.maxChars} characters or fewer.`,
  },
  description: {
    TOO_LONG: `Keep it to ${STORE_DESCRIPTION_MAX_CHARS} characters or fewer.`,
  },
};

/** One plain sentence for a screening or format reason. It never repeats the submitted text. */
export function reasonText(field: string, code: string): string {
  return FIELD_TEXT[field]?.[code] ?? SCREEN_TEXT[code] ?? "This needs a change. Try different wording.";
}

/** The 422 `details.reasons` of a refused text, as plain sentences per field. */
export function reasonsByField(error: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!(error instanceof ApiError)) return out;
  const reasons = error.details.reasons;
  if (!Array.isArray(reasons)) return out;
  for (const entry of reasons) {
    if (typeof entry !== "object" || entry === null) continue;
    const { field, code } = entry as { field?: unknown; code?: unknown };
    if (typeof field !== "string" || typeof code !== "string") continue;
    const text = reasonText(field, code);
    const list = out[field] ?? [];
    if (!list.includes(text)) list.push(text);
    out[field] = list;
  }
  return out;
}

const ERROR_TEXT: Record<string, string> = {
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
  CREATOR_LOCKED: "Creator access is not open for you yet.",
  COMPANY_EXISTS: "You already have a shop.",
  HANDLE_TAKEN: "That handle is taken. Try another.",
  HANDLE_RESERVED: "That handle is reserved. Try another.",
  RELIEF_NOT_ELIGIBLE: "The relief grant is not available right now.",
  RELIEF_LIMIT: "All of your relief claims have been used.",
  INSUFFICIENT_FUNDS: "Your balance does not cover this. Nothing was charged.",
  CHECKOUT_EXPIRED: "That quote expired. Nothing was charged. Get a fresh one.",
  RATE_LIMITED: "Too many tries in a short time. Wait a moment, then try again.",
  BUSY: "DeluluMart is busy. Try again in a moment.",
  PRODUCT_UNAVAILABLE: "That product is not available any more.",
  CONFLICT: "You have saved that product before. Pick another one.",
};

/** Plain-language text for an API failure; falls back to the server's own message. */
export function sellingErrorText(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.code] ?? error.message;
  return "Something went wrong. Try again.";
}

export function errorCodeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/** The creator-access page of the person who unlocked, in a sentence. */
export function unlockRouteText(source: CreatorAccessResponse["source"]): string {
  if (source === "PURCHASE_THRESHOLD") return "You unlocked it by spending your balance down below ₹1 crore.";
  if (source === "ACHIEVEMENT") return "You unlocked it with the Inventor Passport.";
  return "Creator access is open for you.";
}

/** Where "Create your first listing" goes: the studio's new-listing editor. */
export const LISTING_HREF = "/studio/new";
