import { POST as runJobsRoute } from "@/app/api/internal/jobs/run/route";
import { cronAuthorized, signedJobsRequest } from "@/server/cron";
import { env } from "@/server/env";

/**
 * GET /api/cron/daily: the Vercel Cron entry (vercel.json; Hobby runs it once a day). Authorised
 * ONLY by `Authorization: Bearer <CRON_SECRET>` (constant-time); 401 otherwise, 503 when the cron
 * or the jobs are not configured. It then makes one request to the internal jobs endpoint, signed
 * with JOBS_SIGNING_KEY like any scheduler's, and handles it in this same function: the jobs run
 * through the one authenticated path (signature, replay guard, budget). Every job is idempotent,
 * so a late, doubled or extra run (an external scheduler as well) is harmless.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const { cronSecret, jobsSigningKey, appOrigin } = env();
  if (!cronAuthorized(request.headers.get("authorization"), cronSecret)) {
    return new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 401, headers: NO_STORE });
  }
  if (jobsSigningKey === null) {
    return new Response(JSON.stringify({ error: { code: "MAINTENANCE" } }), {
      status: 503,
      headers: NO_STORE,
    });
  }
  const response = await runJobsRoute(signedJobsRequest(appOrigin, jobsSigningKey, Date.now()));
  // the jobs report holds counts only
  return new Response(await response.text(), { status: response.status, headers: NO_STORE });
}
