import "./server-only";
import {
  checkAppealStatement,
  checkReportDetail,
  DomainError,
  REPORT_REASONS,
  REPORT_TARGETS,
  type ScreenReason,
  screenText,
} from "@delulu/core";
import { z } from "zod";

/**
 * Request shapes of reports, appeals and blocks. A report's detail is checked for length and
 * control characters and screened with screenText only to flag it for the Super Admin: nothing is
 * stripped or refused on the verdict, the detail is stored as given, and it is never shown to the
 * reported party. A refusal is VALIDATION_FAILED with `details.reasons` [{field, code}].
 */

export const reportBody = z.strictObject({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  detail: z.string().max(2_000).nullable().optional(),
});

export function checkReport(b: z.infer<typeof reportBody>): { detail: string | null; detailFlags: string[] } {
  const detail = checkReportDetail(b.detail);
  if (!detail.ok) {
    throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", {
      reasons: [{ field: "detail", code: detail.code }],
    });
  }
  if (detail.value === null) return { detail: null, detailFlags: [] };
  const screened = screenText({ detail: detail.value });
  const flags = screened.verdict === "OK" ? [] : screened.reasons.map((r: ScreenReason) => r.code);
  return { detail: detail.value, detailFlags: [...new Set(flags)] };
}

export const appealBody = z.strictObject({ statement: z.string().max(5_000) });

export function checkStatement(statement: string): string {
  const checked = checkAppealStatement(statement);
  if (!checked.ok) {
    throw new DomainError("VALIDATION_FAILED", "Some fields need changes.", {
      reasons: [{ field: "statement", code: checked.code }],
    });
  }
  return checked.value;
}

export const blockBody = z.strictObject({ companyId: z.uuid() });

export const adminDecisionBody = <T extends readonly [string, ...string[]]>(outcomes: T) =>
  z.strictObject({ outcome: z.enum(outcomes), reason: z.string().max(1000) });
