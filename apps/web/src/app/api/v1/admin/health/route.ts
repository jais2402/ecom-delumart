import { adminHealth } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/health (Super Admin only; 403 for anyone else, from the database): whether the
 * deployment is configured as intended, with NO secret values: which optional features are on, the
 * sign-in provider, database TLS, the latest applied migration, the phone verification mode, the
 * session lifetime and when the jobs last ran.
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session }) => {
    const db = await adminHealth(webPool(), { authSessionId: session.id });
    const e = env();
    return {
      json: {
        commit: e.commit,
        authProvider: e.authProvider,
        supabaseConfigured: e.supabase !== null,
        databaseTls: e.databaseTls,
        databaseCaPinned: e.databaseCa !== null,
        serverless: e.serverless,
        jobsEnabled: e.jobsSigningKey !== null && e.databaseUrlJobs !== null,
        dailyCronEnabled: e.cronSecret !== null,
        analyticsEnabled: e.analyticsKey !== null,
        geoSource: e.geoSource,
        trustedProxyHops: e.trustedProxyHops,
        migrationVersion: db.migrationVersion,
        phoneVerification: db.phoneVerification,
        sessionMaxAgeSeconds: db.sessionMaxAgeSeconds,
        jobsLastRunAt: db.jobsLastRunAt,
        jobsRuns: db.jobsRuns,
      },
    };
  },
);
