/**
 * Product ratings and reviews (docs/decisions.md #14). Pure: the shape rules of a review, its text
 * screening, and the integer arithmetic of an average. The web server checks and screens a review
 * here before calling the database (migration 0078), which checks the shape again and refuses
 * link-like and long digit runs as a backstop; it never sees the screening detail.
 *
 * Screening uses the same rules as listing and store text (`screenText`): anything whose verdict is
 * not OK is refused with [{field, code}] reasons, because there is no review queue for reviews.
 * No submitted text is ever echoed in a refusal.
 */
import { DomainError } from "../errors/index";
import { screenText } from "../screening/index";

/** Tunables (CLAUDE.md invariant 10). The database reads the same keys from configuration. */
export const REVIEW_RULES = {
  rating: { min: 1, max: 5 },
  /** `review_title_max_chars` */
  titleMaxChars: 80,
  /** `review_body_max_chars` */
  bodyMaxChars: 1000,
  /** Reviews per public page (`review_page_size`). */
  pageSize: 10,
} as const;

export type ReviewField = "rating" | "title" | "body";
export type ReviewProblemCode = "REQUIRED" | "OUT_OF_RANGE" | "TOO_LONG" | "CONTROL_CHARACTERS" | string;

export interface ReviewProblem {
  field: ReviewField;
  code: ReviewProblemCode;
}

export interface ReviewInput {
  rating: unknown;
  title?: string | null | undefined;
  body?: string | null | undefined;
}

export interface ReviewText {
  rating: number;
  title: string | null;
  body: string | null;
}

export type ReviewCheck = { ok: true; value: ReviewText } | { ok: false; problems: ReviewProblem[] };

const chars = (s: string): number => [...s].length;
const CONTROL = (s: string): boolean => /\p{Cc}/u.test(s);
const CONTROL_BUT_NEWLINE = (s: string): boolean => /\p{Cc}/u.test(s.replaceAll("\n", ""));

/** A trimmed text, or null when absent or blank. */
function textOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * Checks and screens a review. Shape problems (every field) come first; screening runs only on a
 * well-formed review, so a refusal never mixes the two.
 */
export function checkReview(input: ReviewInput): ReviewCheck {
  const problems: ReviewProblem[] = [];
  const r = input.rating;
  if (r === null || r === undefined) problems.push({ field: "rating", code: "REQUIRED" });
  else if (
    typeof r !== "number" ||
    !Number.isInteger(r) ||
    r < REVIEW_RULES.rating.min ||
    r > REVIEW_RULES.rating.max
  )
    problems.push({ field: "rating", code: "OUT_OF_RANGE" });
  const title = textOf(input.title);
  const body = textOf(input.body);
  if (title !== null) {
    if (chars(title) > REVIEW_RULES.titleMaxChars) problems.push({ field: "title", code: "TOO_LONG" });
    else if (CONTROL(title)) problems.push({ field: "title", code: "CONTROL_CHARACTERS" });
  }
  if (body !== null) {
    if (chars(body) > REVIEW_RULES.bodyMaxChars) problems.push({ field: "body", code: "TOO_LONG" });
    else if (CONTROL_BUT_NEWLINE(body)) problems.push({ field: "body", code: "CONTROL_CHARACTERS" });
  }
  if (problems.length > 0) return { ok: false, problems };

  const fields: Record<string, string> = {};
  if (title !== null) fields.title = title;
  if (body !== null) fields.body = body;
  if (Object.keys(fields).length > 0) {
    const screened = screenText(fields);
    if (screened.verdict !== "OK") {
      return {
        ok: false,
        problems: screened.reasons.map((x) => ({ field: x.field as ReviewField, code: x.code })),
      };
    }
  }
  return { ok: true, value: { rating: r as number, title, body } };
}

/** The checked review, or REVIEW_INVALID with `details.reasons` ([{field, code}] only). */
export function requireValidReview(input: ReviewInput): ReviewText {
  const result = checkReview(input);
  if (!result.ok) {
    throw new DomainError("REVIEW_INVALID", "Some fields need changes.", {
      reasons: result.problems.map((p) => ({ field: p.field, code: p.code })),
    });
  }
  return result.value;
}

/**
 * The average rating times ten, rounded half up, from the integer sum and count: floor((20·sum +
 * count) / (2·count)). 0 when there are no reviews.
 */
export function averageTenths(sum: number, count: number): number {
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(count) || count <= 0 || sum < 0) return 0;
  return Math.floor((20 * sum + count) / (2 * count));
}

/** "4.3" from 43: integer digits only, never a float. */
export function formatAverage(tenths: number): string {
  const t = Math.max(0, Math.trunc(tenths));
  return `${Math.trunc(t / 10)}.${t % 10}`;
}

/** The accessible name of a rating summary, e.g. "4.3 out of 5 stars, 12 reviews". */
export function ratingLabel(tenths: number, count: number): string {
  if (count <= 0) return "No reviews yet";
  return `${formatAverage(tenths)} out of 5 stars, ${count} ${count === 1 ? "review" : "reviews"}`;
}

/** Whole percentages (rounded half up) of each star count in the total; zeros when there are none. */
export function distributionPercents(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  return counts.map((c) => Math.floor((200 * c + total) / (2 * total)));
}
