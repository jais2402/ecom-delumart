import "./server-only";
import { DomainError, screenListing } from "@delulu/core";
import {
  applyScreening,
  expiredPhoneHolds,
  moderationSafetyNet,
  pendingScreenings,
  phoneHoldDone,
  purgeAnalyticsEvents,
  purgeIdempotencyRecords,
  purgeRateCounters,
  rollupAnalytics,
  type SafetyNetResult,
  terminateStuckMoneySessions,
} from "@delulu/db/runtime";
import type pg from "pg";
import { SERVER_CONFIG } from "./config";
import { jobsPool } from "./db";
import { env } from "./env";

/**
 * The job runner (LLD §9), on the app_jobs pool (DATABASE_URL_JOBS). One run, within `budgetMs`:
 *  1. screening: each submitted revision waiting in SCREENING, oldest first, is screened with
 *     screenListing (@delulu/core) and the verdict applied by core.screening_apply. A revision
 *     that is no longer pinned (CONFLICT) is skipped; any failure (an error in screening, the
 *     database busy or down) leaves it in SCREENING for a later run: nothing is ever approved by
 *     default. With publication switched off the database applies nothing (PAUSED) and the run
 *     stops screening;
 *  2. the moderation safety net (records, once a day, that a listing has waited for review too
 *     long; it never switches publication off);
 *  3. the rate counter purge, the idempotency record purge and the stuck-session watchdog;
 *  4. analytics (0052): the daily rollup of yesterday and today (idempotent, suppressed places) and
 *     the purge of raw events past their retention (rollups are kept);
 *  5. phone holds (ninth review, major 1b; Supabase only): numbers the server set on a sign-in user
 *     whose code lifetime has passed and that are still unconfirmed are cleared through the Auth
 *     admin API, so an abandoned (or squatted) number is free again.
 * Every step is idempotent, so overlapping or repeated runs are safe. The report holds counts only
 * (no listing text, no ids of people).
 */
export interface JobsReport {
  screening: {
    processed: number;
    outcomes: Record<string, number>;
    skipped: number;
    failed: number;
    paused: boolean;
  };
  safetyNet: SafetyNetResult | null;
  ratePurged: number | null;
  idempotencyPurged: number | null;
  terminated: number | null;
  /** Events rolled up for yesterday and today (UTC), or null when the step did not run. */
  analyticsRollup: { yesterdayEvents: number; todayEvents: number } | null;
  analyticsPurged: number | null;
  /** Unconfirmed phone numbers released at the sign-in service, or null when the step did not run. */
  phoneHoldsReleased: number | null;
  budgetExhausted: boolean;
}

export interface RunJobsOptions {
  budgetMs?: number;
  /** The clock (milliseconds), injectable for tests. */
  now?: () => number;
  /** The app_jobs pool; defaults to the server's (DATABASE_URL_JOBS). */
  pool?: pg.Pool;
}

const failed = (step: string, error: unknown) => {
  // the step and an error code only: messages can carry SQL or values
  const code = error instanceof DomainError ? error.code : ((error as { code?: unknown } | null)?.code ?? "");
  console.error(`[jobs] ${step} failed`, String(code));
};

export async function runJobs(options: RunJobsOptions = {}): Promise<JobsReport> {
  const pool = options.pool ?? jobsPool();
  if (pool === null) throw new DomainError("MAINTENANCE", "The job runner has no database credential.");
  const now = options.now ?? Date.now;
  const budget = Math.min(
    options.budgetMs ?? SERVER_CONFIG.jobs.defaultBudgetMs,
    SERVER_CONFIG.jobs.maxBudgetMs,
  );
  const deadline = now() + budget;
  const left = () => now() < deadline;
  const report: JobsReport = {
    screening: { processed: 0, outcomes: {}, skipped: 0, failed: 0, paused: false },
    safetyNet: null,
    ratePurged: null,
    idempotencyPurged: null,
    terminated: null,
    analyticsRollup: null,
    analyticsPurged: null,
    phoneHoldsReleased: null,
    budgetExhausted: false,
  };

  // 1. screening
  const seen = new Set<string>();
  screening: while (left()) {
    let batch: Awaited<ReturnType<typeof pendingScreenings>>;
    try {
      batch = await pendingScreenings(pool, SERVER_CONFIG.jobs.screeningBatch);
    } catch (error) {
      failed("screening.pending", error);
      break;
    }
    const fresh = batch.filter((item) => !seen.has(item.submissionId));
    if (fresh.length === 0) break;
    for (const item of fresh) {
      if (!left()) break screening;
      seen.add(item.submissionId);
      try {
        const result = screenListing(item.fields);
        const applied = await applyScreening(pool, {
          productId: item.productId,
          versionId: item.versionId,
          verdict: result.verdict,
          reasons: result.reasons,
        });
        if (applied.outcome === "PAUSED") {
          report.screening.paused = true;
          break screening;
        }
        report.screening.processed += 1;
        report.screening.outcomes[applied.outcome] = (report.screening.outcomes[applied.outcome] ?? 0) + 1;
      } catch (error) {
        if (error instanceof DomainError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
          report.screening.skipped += 1;
        } else {
          report.screening.failed += 1;
          failed("screening.apply", error);
        }
      }
    }
    if (batch.length < SERVER_CONFIG.jobs.screeningBatch) break;
  }

  // 2.-3. the periodic steps, each on its own, while the budget lasts
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    if (!left()) return null;
    try {
      return await fn();
    } catch (error) {
      failed(name, error);
      return null;
    }
  };
  report.safetyNet = await step("moderation.safety_net", () => moderationSafetyNet(pool));
  report.ratePurged = await step("rate.purge", () => purgeRateCounters(pool));
  report.idempotencyPurged = await step("idempotency.purge", () => purgeIdempotencyRecords(pool));
  report.terminated = await step("watchdog", () => terminateStuckMoneySessions(pool));
  report.analyticsRollup = await step("analytics.rollup", async () => {
    const r = await rollupAnalytics(pool);
    return { yesterdayEvents: r.yesterday.events, todayEvents: r.today.events };
  });
  report.analyticsPurged = await step("analytics.purge", () => purgeAnalyticsEvents(pool));
  report.phoneHoldsReleased = await step("phone.release", async () => {
    if (env().authProvider !== "supabase" || env().supabase === null) return 0;
    const holds = await expiredPhoneHolds(pool, SERVER_CONFIG.jobs.phoneHoldBatch);
    if (holds.length === 0) return 0;
    const { releaseExpiredPhoneHolds } = await import("./auth/supabase");
    return releaseExpiredPhoneHolds(holds, (hold) => phoneHoldDone(pool, hold));
  });
  report.budgetExhausted = !left();
  return report;
}

/**
 * DEVELOPMENT ONLY: after a submission has committed, run the jobs once so the listing is
 * screened (and published) without a scheduler. In any other environment this does nothing; in
 * production the scheduler calls POST /api/internal/jobs/run.
 */
export async function runJobsInlineInDevelopment(): Promise<void> {
  if (env().nodeEnv !== "development" || jobsPool() === null) return;
  try {
    await runJobs({ budgetMs: SERVER_CONFIG.jobs.inlineBudgetMs });
  } catch (error) {
    failed("inline", error);
  }
}
