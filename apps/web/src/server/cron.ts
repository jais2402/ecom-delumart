import "./server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { JOBS_SIGNATURE_HEADER, JOBS_TIMESTAMP_HEADER, signJobsRequest } from "./jobs-signature";

/**
 * Vercel Cron calls the cron route with `Authorization: Bearer <CRON_SECRET>` (the platform adds
 * the header when the project has a CRON_SECRET environment variable). The comparison is in
 * constant time over SHA-256 digests, so neither the value nor its length leaks through timing.
 */
export function cronAuthorized(header: string | null, secret: string | null): boolean {
  if (secret === null || header === null) return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1]) return false;
  const given = createHash("sha256").update(match[1], "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(given, expected);
}

/** A request to POST /api/internal/jobs/run signed exactly as an external scheduler signs it. */
export function signedJobsRequest(appOrigin: string, key: Uint8Array, nowMs: number, body = "{}"): Request {
  const timestamp = String(Math.floor(nowMs / 1000));
  return new Request(`${appOrigin}/api/internal/jobs/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [JOBS_TIMESTAMP_HEADER]: timestamp,
      [JOBS_SIGNATURE_HEADER]: signJobsRequest(key, timestamp, body),
    },
    body,
  });
}
