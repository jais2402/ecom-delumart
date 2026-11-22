import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cronAuthorized, signedJobsRequest } from "./cron";
import { checkJobsSignature, JOBS_SIGNATURE_HEADER, JOBS_TIMESTAMP_HEADER } from "./jobs-signature";

describe("the daily cron route's checks", () => {
  const secret = randomBytes(32).toString("hex");

  it("accepts exactly `Bearer <CRON_SECRET>`; anything else, or no secret configured, is refused", () => {
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    for (const header of [
      null,
      "",
      secret,
      `bearer ${secret}`,
      `Bearer ${secret}x`,
      `Bearer ${secret.slice(1)}`,
      "Bearer ",
    ]) {
      expect(cronAuthorized(header, secret), String(header)).toBe(false);
    }
    expect(cronAuthorized(`Bearer ${secret}`, null)).toBe(false);
  });

  it("signs the internal jobs request the way the jobs endpoint checks it", async () => {
    const key = randomBytes(32);
    const now = 1_800_000_000_000;
    const req = signedJobsRequest("https://delulu.example", key, now);
    expect(req.url).toBe("https://delulu.example/api/internal/jobs/run");
    const problem = checkJobsSignature({
      key,
      timestamp: req.headers.get(JOBS_TIMESTAMP_HEADER),
      signature: req.headers.get(JOBS_SIGNATURE_HEADER),
      body: await req.text(),
      nowMs: now,
      maxAgeSeconds: 60,
    });
    expect(problem).toBeNull();
  });
});
