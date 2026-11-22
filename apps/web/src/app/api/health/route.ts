import { env } from "@/server/env";

/**
 * GET /api/health: public liveness for an uptime monitor. No database call, no configuration, no
 * secret: only that the server answers, the app version and the deployed commit (first 12
 * characters of VERCEL_GIT_COMMIT_SHA, or null).
 */
export const dynamic = "force-dynamic";

const VERSION = "0.0.0";

export async function GET(): Promise<Response> {
  let commit: string | null = null;
  try {
    commit = env().commit;
  } catch {
    // a broken configuration still answers liveness; /api/v1/admin/health tells the operator more
  }
  return new Response(JSON.stringify({ ok: true, version: VERSION, commit }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
