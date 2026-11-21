import "./server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signature of POST /api/internal/jobs/run (LLD §9): the scheduler sends
 *   x-delulu-timestamp: <unix seconds>
 *   x-delulu-signature: hex(HMAC-SHA-256(JOBS_SIGNING_KEY, "<timestamp>.<raw body>"))
 * A request is accepted only with a well-formed timestamp within `maxAgeSeconds` of the server
 * clock (either side) and a signature equal, compared in constant time, to the one computed here.
 * A signature accepted once is refused afterwards: the route records its SHA-256 in the database
 * (core.jobs_accept_request, sixth security review) and fails closed when it cannot.
 */
export const JOBS_TIMESTAMP_HEADER = "x-delulu-timestamp";
export const JOBS_SIGNATURE_HEADER = "x-delulu-signature";

export function signJobsRequest(key: Uint8Array, timestamp: string, body: string): string {
  return createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

export type JobsSignatureProblem = "MISSING" | "MALFORMED" | "STALE" | "MISMATCH";

export function checkJobsSignature(input: {
  key: Uint8Array;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
  maxAgeSeconds: number;
}): JobsSignatureProblem | null {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return "MISSING";
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return "MALFORMED";
  const ageSeconds = Math.abs(input.nowMs / 1000 - Number(timestamp));
  if (!(ageSeconds <= input.maxAgeSeconds)) return "STALE";
  const expected = Buffer.from(signJobsRequest(input.key, timestamp, input.body), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "MISMATCH";
  return null;
}

/** The replay-guard key of a signature: SHA-256 of its (lowercase hex) text. Never the signature. */
export function jobsSignatureHash(signature: string): Buffer {
  return createHash("sha256").update(signature.toLowerCase(), "utf8").digest();
}
