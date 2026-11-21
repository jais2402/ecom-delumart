/**
 * The background jobs' database calls, run as app_jobs (LLD §9). The jobs role never acts as a
 * user (core.actor_id() is NULL for it); it may execute only the job functions: the screening
 * queue and its results (0036), the moderation safety net (0037), the rate counter and
 * idempotency record purges (0031, 0018) and the stuck-session watchdog (0030). Every job is
 * idempotent: running it twice changes nothing the first run did not.
 */
import type { Pool, PoolClient } from "pg";
import { mapCommandError, one, requireUuid } from "./command";
import type { FieldCode } from "./listing";
import { withTransaction } from "./transaction";

async function asJobs<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(pool, fn, { role: "app_jobs", lockTimeout: "2s", statementTimeout: "30s" });
  } catch (error) {
    throw mapCommandError(error);
  }
}

export interface PendingScreening {
  submissionId: string;
  productId: string;
  versionId: string;
  kind: "FIRST" | "REVISION";
  fields: { name: string; hook: string | null; description: string; altText: string };
  submittedAt: Date;
}

/** Revisions waiting for screening, oldest first (at most `limit`, 1-100). */
export async function pendingScreenings(pool: Pool, limit: number): Promise<PendingScreening[]> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{
      submission_id: string;
      product_id: string;
      version_id: string;
      kind: "FIRST" | "REVISION";
      name: string;
      hook: string | null;
      description: string;
      alt_text: string;
      submitted_at: Date;
    }>("SELECT * FROM core.screening_pending($1)", [limit]);
    return rows.map((r) => ({
      submissionId: r.submission_id,
      productId: r.product_id,
      versionId: r.version_id,
      kind: r.kind,
      fields: { name: r.name, hook: r.hook, description: r.description, altText: r.alt_text },
      submittedAt: r.submitted_at,
    }));
  });
}

export type ScreeningVerdict = "OK" | "NEEDS_REVIEW" | "REJECT";

export interface ScreeningOutcome {
  outcome: "PUBLISHED" | "NEEDS_STOCK" | "REVISED" | "NEEDS_REVIEW" | "REJECTED" | "PAUSED";
  productId: string;
  versionId: string;
}

/** Applies a screening verdict to the pinned revision; CONFLICT when it is no longer pinned. */
export async function applyScreening(
  pool: Pool,
  input: { productId: string; versionId: string; verdict: ScreeningVerdict; reasons: readonly FieldCode[] },
): Promise<ScreeningOutcome> {
  requireUuid(input.productId, "productId");
  requireUuid(input.versionId, "versionId");
  return asJobs(pool, (c) =>
    one<ScreeningOutcome>(c, "SELECT core.screening_apply($1, $2, $3, $4) AS r", [
      input.productId,
      input.versionId,
      input.verdict,
      JSON.stringify(input.reasons.map((r) => ({ field: r.field, code: r.code }))),
    ]),
  );
}

export interface SafetyNetResult {
  /** Some NEEDS_REVIEW listing has waited longer than the threshold (48 h by default). */
  overdue: boolean;
  /** How many have. */
  count: number;
  oldestAgeSeconds: number | null;
  /** This run wrote the day's SYSTEM audit row (at most one per UTC day). */
  audited: boolean;
}

/**
 * The moderation safety net (0046): never switches publication off; when a listing has waited for
 * review too long, it records that once per UTC day in the audit chain.
 */
export async function moderationSafetyNet(pool: Pool): Promise<SafetyNetResult> {
  const r = await asJobs(pool, (c) =>
    one<{
      overdue: boolean;
      count: number | string;
      oldestAgeSeconds: number | string | null;
      audited: boolean;
    }>(c, "SELECT core.moderation_safety_net() AS r", []),
  );
  return {
    overdue: r.overdue === true,
    count: Number(r.count),
    oldestAgeSeconds: r.oldestAgeSeconds === null ? null : Number(r.oldestAgeSeconds),
    audited: r.audited === true,
  };
}

/** Expired rate counter windows (older than two days). */
export async function purgeRateCounters(pool: Pool): Promise<number> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ n: number }>("SELECT core.rate_purge() AS n");
    return Number(rows[0]?.n ?? 0);
  });
}

/** Idempotency records past their retention. */
export async function purgeIdempotencyRecords(pool: Pool): Promise<number> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ n: string }>("SELECT core.purge_idempotency_records()::text AS n");
    return Number(rows[0]?.n ?? 0);
  });
}

/** Ends application backends that held locks too long (0030). */
export async function terminateStuckMoneySessions(pool: Pool): Promise<number> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ n: number }>("SELECT ops.terminate_stuck_money_sessions() AS n");
    return Number(rows[0]?.n ?? 0);
  });
}

/**
 * The jobs endpoint's replay guard (0048): records the SHA-256 of an accepted request signature
 * with its signed time. True the first time; false for a replay. Throws when the database cannot
 * answer: the caller then refuses the request (fails closed).
 */
export async function acceptJobsRequest(
  pool: Pool,
  input: { signatureHash: Uint8Array; requestAt: Date },
): Promise<boolean> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ ok: boolean }>("SELECT core.jobs_accept_request($1, $2) AS ok", [
      Buffer.from(input.signatureHash),
      input.requestAt,
    ]);
    return rows[0]?.ok === true;
  });
}

export interface AnalyticsRollupDay {
  day: string;
  events: number;
  rows: number;
  minVisitors: number;
}

/** Rolls up yesterday's and today's analytics events (UTC); idempotent (0052). */
export async function rollupAnalytics(
  pool: Pool,
): Promise<{ yesterday: AnalyticsRollupDay; today: AnalyticsRollupDay }> {
  const r = await asJobs(pool, (c) =>
    one<Record<string, Record<string, unknown>>>(c, "SELECT core.analytics_rollup_job() AS r", []),
  );
  const day = (d: Record<string, unknown> | undefined): AnalyticsRollupDay => ({
    day: String(d?.day ?? ""),
    events: Number(d?.events ?? 0),
    rows: Number(d?.rows ?? 0),
    minVisitors: Number(d?.minVisitors ?? 0),
  });
  return { yesterday: day(r.yesterday), today: day(r.today) };
}

/** Deletes raw analytics events past their retention (rollups are kept); returns how many. */
export async function purgeAnalyticsEvents(pool: Pool): Promise<number> {
  return asJobs(pool, async (c) => {
    const { rows } = await c.query<{ n: string }>("SELECT core.analytics_purge_job()::text AS n");
    return Number(rows[0]?.n ?? 0);
  });
}
