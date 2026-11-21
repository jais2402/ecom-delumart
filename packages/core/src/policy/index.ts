/**
 * Trust and safety rules (PRD §7.7, LLD §9 moderation.safety_net, §11.2): reports, the automatic
 * hide at three independent reports, appeals and blocks. Pure: callers supply the facts and the
 * clock. The database (migration 0040) applies the same rules to committed rows; these are the
 * shapes the web layer checks before calling it and the rule its tests are written against.
 */
import { DomainError } from "../errors/index";

export const REPORT_REASONS = [
  "SEXUAL",
  "HATE",
  "HARASSMENT",
  "VIOLENCE",
  "SCAM_OR_PAYMENT",
  "PERSONAL_INFO",
  "IMPERSONATION",
  "COPYRIGHT",
  "OTHER",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_TARGETS = ["PRODUCT", "STORE"] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_RULES = {
  /** Optional free text, never shown to the reported party. */
  detailMaxChars: 500,
  /** Reports per account per rolling hour (LLD §11.2). */
  perHour: 5,
  /** Distinct qualifying reporters that hide a published product at once. */
  hideThreshold: 3,
  /** A reporter's account must be at least this old to count. */
  reporterMinAgeHours: 24,
} as const;

export const APPEAL_RULES = { statementMinChars: 20, statementMaxChars: 1_000 } as const;

/** The reason the owner of an automatically hidden listing sees. */
export const AUTO_HIDE_REASON = "Hidden pending review";

const HOUR_MS = 3_600_000;

export interface ReportFact {
  reporterId: string;
  reporterCreatedAt: Date;
  /** The reporter owns (or is otherwise a party of) the reported product's company. */
  reporterIsOwnerParty: boolean;
}

/** Distinct reporters that count towards the automatic hide at `now`. */
export function qualifyingReporters(
  reports: readonly ReportFact[],
  now: Date,
  rules: { reporterMinAgeHours: number } = REPORT_RULES,
): number {
  const minAgeMs = rules.reporterMinAgeHours * HOUR_MS;
  const ids = new Set<string>();
  for (const r of reports) {
    if (r.reporterIsOwnerParty) continue;
    if (now.getTime() - r.reporterCreatedAt.getTime() < minAgeMs) continue;
    ids.add(r.reporterId);
  }
  return ids.size;
}

/** A published product with this many qualifying open reports is hidden pending review. */
export function autoHideDue(
  reports: readonly ReportFact[],
  now: Date,
  rules: { reporterMinAgeHours: number; hideThreshold: number } = REPORT_RULES,
): boolean {
  return qualifyingReporters(reports, now, rules) >= rules.hideThreshold;
}

function hasControl(value: string, allowNewline: boolean): boolean {
  return [...value].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && !(allowNewline && c === 0x0a)) || c === 0x7f;
  });
}

export type TextProblem = "TOO_SHORT" | "TOO_LONG" | "CONTROL_CHARACTERS";

/** A report's optional detail, trimmed (empty becomes null); stored as given otherwise. */
export function checkReportDetail(
  detail: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; code: TextProblem } {
  if (detail === null || detail === undefined) return { ok: true, value: null };
  const value = detail.trim();
  if (value === "") return { ok: true, value: null };
  if ([...value].length > REPORT_RULES.detailMaxChars) return { ok: false, code: "TOO_LONG" };
  if (hasControl(value, true)) return { ok: false, code: "CONTROL_CHARACTERS" };
  return { ok: true, value };
}

/** An appeal statement, trimmed: 20 to 1,000 characters, no control characters but line breaks. */
export function checkAppealStatement(
  statement: string,
): { ok: true; value: string } | { ok: false; code: TextProblem } {
  const value = statement.trim();
  const n = [...value].length;
  if (n < APPEAL_RULES.statementMinChars) return { ok: false, code: "TOO_SHORT" };
  if (n > APPEAL_RULES.statementMaxChars) return { ok: false, code: "TOO_LONG" };
  if (hasControl(value, true)) return { ok: false, code: "CONTROL_CHARACTERS" };
  return { ok: true, value };
}

/** `R-` and ten symbols of the 32-symbol alphabet without look-alikes (the database generates it). */
export const REPORT_REFERENCE = /^R-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;

export function isReportReference(value: string): boolean {
  return REPORT_REFERENCE.test(value);
}

/** Merchant read models: the period of an earnings report, in whole days (LLD: company time zone). */
export const EARNINGS_RULES = { defaultDays: 7, maxDays: 90, timeZone: "Asia/Kolkata" } as const;

export function earningsDays(days: number | undefined): number {
  if (days === undefined) return EARNINGS_RULES.defaultDays;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new DomainError("VALIDATION_FAILED", "days is a whole number of at least 1");
  }
  return Math.min(days, EARNINGS_RULES.maxDays);
}

/** Merchant inventory: a product is low on stock at or below this many available units. */
export const LOW_STOCK_UNITS = 5;
