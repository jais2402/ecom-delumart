import { describe, expect, it } from "vitest";
import { DRAFT_NOTICE_TITLE, type PolicyDocument, PRIVACY, RESEARCH, TERMS } from "./legal-content";

const docs: PolicyDocument[] = [TERMS, PRIVACY, RESEARCH];
const text = (d: PolicyDocument) =>
  d.sections.flatMap((s) => s.blocks.flatMap((b) => (typeof b === "string" ? [b] : [...b.list]))).join("\n");

describe("R2.1 Help and policies: the draft policy text", () => {
  it("is marked as a draft for legal review", () => {
    expect(DRAFT_NOTICE_TITLE).toBe("Draft for legal review: not yet in force");
  });
  it("gives every section its own anchor and some text", () => {
    for (const d of docs) {
      const ids = d.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of d.sections) expect(s.blocks.length).toBeGreaterThan(0);
    }
  });
  it("leaves company, contact, law and retention as bracketed placeholders, never invented", () => {
    expect(text(TERMS)).toContain("[Company legal name]");
    expect(text(TERMS)).toContain("[Governing law, jurisdiction and dispute process");
    expect(text(PRIVACY)).toContain("[Contact for privacy requests]");
    expect(text(PRIVACY)).toContain("[Retention periods: to be confirmed by the privacy reviewer.]");
    expect(text(RESEARCH)).toContain("[Retention period for the de-identified research data");
  });
  it("covers the privacy commitments: fictional money, what is collected, research and the opt-out", () => {
    expect(text(TERMS)).toMatch(/fictional/i);
    expect(text(TERMS)).toMatch(/Nothing real is sold or shipped/);
    expect(text(PRIVACY)).toMatch(/phone number/);
    expect(text(PRIVACY)).toMatch(/Sellers never see your delivery address/);
    expect(text(RESEARCH)).toMatch(/opt out/i);
    expect(text(RESEARCH)).toMatch(/fewer than 10 accounts/);
  });
  it("does not promise features the app does not have", () => {
    expect(text(PRIVACY)).toMatch(/not available in the app yet/);
  });
});
