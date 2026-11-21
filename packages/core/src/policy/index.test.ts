import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import {
  APPEAL_RULES,
  autoHideDue,
  checkAppealStatement,
  checkReportDetail,
  EARNINGS_RULES,
  earningsDays,
  isReportReference,
  qualifyingReporters,
  REPORT_RULES,
  type ReportFact,
} from "./index";

const NOW = new Date("2026-06-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const fact = (id: string, ageHours: number, ownerParty = false): ReportFact => ({
  reporterId: id,
  reporterCreatedAt: hoursAgo(ageHours),
  reporterIsOwnerParty: ownerParty,
});

describe("§7.7 the automatic hide at three independent reports", () => {
  it("hides exactly at the third distinct reporter whose account is at least 24 hours old", () => {
    expect(autoHideDue([fact("a", 48), fact("b", 48)], NOW)).toBe(false);
    expect(autoHideDue([fact("a", 48), fact("b", 48), fact("c", 24)], NOW)).toBe(true);
  });

  it("a young account, the owner's side and repeated reports by one account do not count", () => {
    expect(autoHideDue([fact("a", 48), fact("b", 48), fact("c", 23.99)], NOW)).toBe(false);
    expect(autoHideDue([fact("a", 48), fact("b", 48), fact("owner", 999, true)], NOW)).toBe(false);
    expect(autoHideDue([fact("a", 48), fact("a", 48), fact("b", 48)], NOW)).toBe(false);
  });

  it("property: the count never exceeds the distinct reporters and ignores the owner's side", () => {
    const report = fc.record({
      reporterId: fc.constantFrom("a", "b", "c", "d", "e"),
      age: fc.integer({ min: 0, max: 100 }),
      ownerParty: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(report, { maxLength: 20 }), (rs) => {
        const facts = rs.map((r) => fact(r.reporterId, r.age, r.ownerParty));
        const n = qualifyingReporters(facts, NOW);
        expect(n).toBeLessThanOrEqual(new Set(rs.map((r) => r.reporterId)).size);
        const withoutOwner = facts.filter((f) => !f.reporterIsOwnerParty);
        expect(qualifyingReporters(withoutOwner, NOW)).toBe(n);
        expect(autoHideDue(facts, NOW)).toBe(n >= REPORT_RULES.hideThreshold);
      }),
    );
  });
});

describe("report detail and appeal statement", () => {
  it("a report detail is optional, at most 500 characters, kept as given (trimmed)", () => {
    expect(checkReportDetail(undefined)).toEqual({ ok: true, value: null });
    expect(checkReportDetail("   ")).toEqual({ ok: true, value: null });
    expect(checkReportDetail(" Looks like a scam\nline two ")).toEqual({
      ok: true,
      value: "Looks like a scam\nline two",
    });
    expect(checkReportDetail("x".repeat(REPORT_RULES.detailMaxChars))).toMatchObject({ ok: true });
    expect(checkReportDetail("x".repeat(REPORT_RULES.detailMaxChars + 1))).toEqual({
      ok: false,
      code: "TOO_LONG",
    });
    expect(checkReportDetail("bad\u0007bell")).toEqual({ ok: false, code: "CONTROL_CHARACTERS" });
  });

  it("an appeal statement is 20 to 1,000 characters", () => {
    expect(checkAppealStatement("x".repeat(APPEAL_RULES.statementMinChars - 1))).toEqual({
      ok: false,
      code: "TOO_SHORT",
    });
    expect(checkAppealStatement(`  ${"x".repeat(APPEAL_RULES.statementMinChars)}  `)).toMatchObject({
      ok: true,
    });
    expect(checkAppealStatement("x".repeat(APPEAL_RULES.statementMaxChars + 1))).toEqual({
      ok: false,
      code: "TOO_LONG",
    });
  });

  it("a case reference is R- and ten symbols without look-alikes", () => {
    expect(isReportReference("R-ABCDEFGH23")).toBe(true);
    expect(isReportReference("R-ABCDEFGH2O")).toBe(false);
    expect(isReportReference("R-ABCDEFGH2")).toBe(false);
  });
});

describe("earnings period", () => {
  it("defaults to 7 days and is capped at 90", () => {
    expect(earningsDays(undefined)).toBe(EARNINGS_RULES.defaultDays);
    expect(earningsDays(30)).toBe(30);
    expect(earningsDays(365)).toBe(90);
    expect(() => earningsDays(0)).toThrow(DomainError);
    expect(() => earningsDays(1.5)).toThrow(DomainError);
  });
});
