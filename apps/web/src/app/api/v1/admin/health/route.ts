import { adminHealth } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { RATE_RULES } from "@/server/rate-limit";

/**
 * GET /api/v1/admin/health (Super Admin only; 403 for anyone else, from the database): whether the
 * deployment is configured as intended, with NO secret values: which optional features are on, the
 * sign-in provider, database TLS, the latest applied migration, the phone verification mode, the
 * session lifetime and when the jobs last ran. `captcha` is "on" when Turnstile protects sign-in and
 * the phone step, "off" otherwise; "off" with the Supabase provider is also listed in `warnings`
 * (ninth review, major 2a: only an explicit CAPTCHA=off allows it in production).
 */
export const GET = route(
  { auth: "session", rateLimits: [{ rule: RATE_RULES.adminActor }] },
  async ({ session }) => {
    const db = await adminHealth(webPool(), { authSessionId: session.id });
    const e = env();
    const warnings: string[] = [];
    if (e.captcha === null && e.authProvider === "supabase") {
      warnings.push("captcha: off (CAPTCHA=off): sign-in and the phone step have no bot protection");
    }
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
        captcha: e.captcha === null ? "off" : "on",
        googleSignIn: e.googleSignIn,
        warnings,
      },
    };
  },
);
