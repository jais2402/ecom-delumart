import { REVIEW_RULES } from "@delulu/core";

/**
 * Ratings and reviews in the browser (docs/decisions.md #14): the API shapes and the words shown
 * for refusals. Averages arrive as integer tenths and are formatted by @delulu/core, never as floats.
 */

export interface PublicReviewItem {
  rating: number;
  title: string | null;
  body: string | null;
  author: { handle: string } | null;
  createdOn: string;
  edited: boolean;
  verifiedOwner: true;
}

export interface ProductReviewsResponse {
  productId: string;
  count: number;
  ratingSum: number;
  averageTenths: number;
  /** Counts of 1 to 5 stars. */
  distribution: number[];
  items: PublicReviewItem[];
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OwnReviewView {
  rating: number;
  title: string | null;
  body: string | null;
  createdOn: string;
  edited: boolean;
  hidden: boolean;
  hiddenReason: string | null;
  public: boolean;
}

export interface MyReviewResponse {
  productId: string;
  eligible: boolean;
  reason: "NOT_OWNER" | "SELLER" | "UNAVAILABLE" | "ACCOUNT" | null;
  handle: string | null;
  review: OwnReviewView | null;
}

export interface SaveReviewResponse {
  productId: string;
  changed: boolean;
  review: OwnReviewView;
}

export interface AdminReviewItem {
  reviewId: string;
  productId: string;
  productName: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  handle: string | null;
  createdOn: string;
  edited: boolean;
  hidden: boolean;
  hiddenReason: string | null;
  public: boolean;
}

export interface AdminReviewsResponse {
  items: AdminReviewItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type ReviewField = "rating" | "title" | "body";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-26" -> "26 Nov 2026", read as a calendar day (no time zone is applied to it). */
export function formatReviewDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || month === undefined) return day;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** The person-facing text for one refused field (no submitted text is ever repeated). */
export function reviewFieldMessage(field: ReviewField, code: string): string {
  switch (code) {
    case "REQUIRED":
      return field === "rating" ? "Choose a star rating." : "This is required.";
    case "OUT_OF_RANGE":
      return "Choose from 1 to 5 stars.";
    case "TOO_LONG":
      return `Use at most ${(field === "title" ? REVIEW_RULES.titleMaxChars : REVIEW_RULES.bodyMaxChars).toLocaleString("en-IN")} characters.`;
    case "CONTROL_CHARACTERS":
      return field === "title" ? "Keep the title on one line." : "Remove special characters.";
    case "INVISIBLE":
      return "Remove hidden or formatting characters (for example, text pasted from elsewhere).";
    case "LINK":
      return "Remove links and web addresses.";
    case "EMAIL":
      return "Remove email addresses.";
    case "PHONE":
      return "Remove phone numbers and long numbers such as card numbers.";
    case "PAYMENT":
      return "Remove payment requests.";
    case "BLOCKED_TERM":
      return "Remove words that are not allowed here.";
    default:
      return "Rephrase this: it reads like an official, brand or shouted claim.";
  }
}

/** Field messages from a REVIEW_INVALID refusal's `details.reasons` (first reason per field). */
export function reviewFieldErrors(
  details: Readonly<Record<string, unknown>>,
): Partial<Record<ReviewField, string>> {
  const out: Partial<Record<ReviewField, string>> = {};
  const reasons = Array.isArray(details.reasons) ? details.reasons : [];
  for (const r of reasons) {
    const field = (r as { field?: unknown }).field;
    const code = (r as { code?: unknown }).code;
    if ((field === "rating" || field === "title" || field === "body") && typeof code === "string") {
      out[field] ??= reviewFieldMessage(field, code);
    }
  }
  return out;
}

/** Why the signed-in person cannot write a review here, in words. */
export function ineligibleText(reason: MyReviewResponse["reason"]): string {
  switch (reason) {
    case "NOT_OWNER":
      return "Only players who own this product can review it.";
    case "SELLER":
      return "You sell this product, so you cannot review it.";
    case "ACCOUNT":
      return "Your account cannot write reviews right now.";
    default:
      return "Reviews cannot be written for this product right now.";
  }
}
