import { DomainError } from "@delulu/core";
import { z } from "zod";
import { SERVER_CONFIG } from "@/server/config";
import { env } from "@/server/env";
import { errorResponse, RequestError } from "@/server/http";
import { runJobs } from "@/server/jobs";
import { checkJobsSignature, JOBS_SIGNATURE_HEADER, JOBS_TIMESTAMP_HEADER } from "@/server/jobs-signature";

/**
 * POST /api/internal/jobs/run (LLD §9): the scheduler's call, authenticated ONLY by an HMAC-SHA-256
 * signature over "<timestamp>.<raw body>" with JOBS_SIGNING_KEY (headers x-delulu-timestamp, unix
 * seconds, and x-delulu-signature, hex), accepted within 60 seconds of the server clock. No
 * session, no cookie and no CSRF token is read: this is not a browser route (and not under
 * /api/v1). Body: {} or {budgetMs?: 1..45000}. Answers {report} with counts only; 403 for any
 * signature problem (the same answer whatever it is); 503 when the server has no jobs key or
 * jobs credential.
 */
const body = z.strictObject({
  budgetMs: z.number().int().min(1).max(SERVER_CONFIG.jobs.maxBudgetMs).optional(),
});
const NO_STORE = "no-store";

export async function POST(request: Request): Promise<Response> {
  try {
    const { jobsSigningKey } = env();
    if (jobsSigningKey === null) throw new DomainError("MAINTENANCE", "Jobs are not enabled on this server.");
    const text = await request.text();
    if (text.length > SERVER_CONFIG.http.maxBodyBytes) {
      throw new RequestError("VALIDATION_FAILED", "The request body is too large.");
    }
    const problem = checkJobsSignature({
      key: jobsSigningKey,
      timestamp: request.headers.get(JOBS_TIMESTAMP_HEADER),
      signature: request.headers.get(JOBS_SIGNATURE_HEADER),
      body: text,
      nowMs: Date.now(),
      maxAgeSeconds: SERVER_CONFIG.jobs.signatureMaxAgeSeconds,
    });
    if (problem !== null) throw new DomainError("FORBIDDEN", "Signature refused.");
    let json: unknown = {};
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new RequestError("VALIDATION_FAILED", "The request body is not valid JSON.");
      }
    }
    const parsed = body.safeParse(json);
    if (!parsed.success) throw new RequestError("VALIDATION_FAILED", "The request is not valid.");
    const report = await runJobs(
      parsed.data.budgetMs === undefined ? {} : { budgetMs: parsed.data.budgetMs },
    );
    return new Response(JSON.stringify({ report }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
    });
  } catch (error) {
    return errorResponse(error, NO_STORE);
  }
}
