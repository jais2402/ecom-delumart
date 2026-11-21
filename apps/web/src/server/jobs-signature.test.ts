import { describe, expect, it } from "vitest";
import { checkJobsSignature, signJobsRequest } from "./jobs-signature";

const key = Buffer.alloc(32, 9);
const nowMs = 1_800_000_000_000;
const ts = String(nowMs / 1000);
const check = (o: Partial<Parameters<typeof checkJobsSignature>[0]>) =>
  checkJobsSignature({
    key,
    timestamp: ts,
    signature: signJobsRequest(key, ts, "{}"),
    body: "{}",
    nowMs,
    maxAgeSeconds: 60,
    ...o,
  });

describe("jobs request signature", () => {
  it("accepts the signature of the timestamp and body, within 60 seconds either side (inclusive)", () => {
    expect(check({})).toBeNull();
    for (const skew of [-60, 60]) {
      const t = String(nowMs / 1000 + skew);
      expect(check({ timestamp: t, signature: signJobsRequest(key, t, "{}") })).toBeNull();
    }
  });

  it("refuses a missing, malformed, stale or mismatched signature", () => {
    expect(check({ timestamp: null })).toBe("MISSING");
    expect(check({ signature: "" })).toBe("MISSING");
    expect(check({ signature: "xyz" })).toBe("MALFORMED");
    expect(check({ timestamp: "-5" })).toBe("MALFORMED");
    for (const skew of [-61, 61]) {
      const t = String(nowMs / 1000 + skew);
      expect(check({ timestamp: t, signature: signJobsRequest(key, t, "{}") })).toBe("STALE");
    }
    expect(check({ body: '{"budgetMs":1}' })).toBe("MISMATCH");
    expect(check({ key: Buffer.alloc(32, 8) })).toBe("MISMATCH");
  });
});
