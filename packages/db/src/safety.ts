/**
 * Trust and safety (migrations 0039, 0040): reports and the automatic hide at three independent
 * reports, appeals of moderation decisions, blocks, and the Super Admin's report cases. All run as
 * app_web for the caller's sign-in session; the database derives the actor, checks every rule and
 * never shows a reporter's identity to anyone but the Super Admin (and then only as a per-case
 * number) or a block to the blocked store.
 */
import type { Pool } from "pg";
import { asWeb, one, requireUuid } from "./command";
import { type AppealView, appealOf } from "./listing";

type Json = Record<string, unknown>;

interface Session {
  authSessionId: string;
}

const date = (v: unknown): Date => new Date(String(v));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export type ReportTargetType = "PRODUCT" | "STORE";
export type ReportCaseStatus = "OPEN" | "UPHELD" | "DISMISSED";

export interface ReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  /** Stored as given (trimmed); never shown to the reported party. */
  detail?: string | null;
  /** The web layer's screening codes for the detail (advisory, shown to the Super Admin only). */
  detailFlags?: readonly string[];
}

export interface ReportReceipt {
  reference: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  status: ReportCaseStatus;
  createdAt: Date;
}

export interface MyReport {
  reference: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  status: ReportCaseStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

export async function createReport(pool: Pool, input: Session & ReportInput): Promise<ReportReceipt> {
  requireUuid(input.targetId, "targetId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.report_create($1, $2, $3, $4, $5::jsonb) AS r", [
      input.targetType,
      input.targetId,
      input.reason,
      input.detail ?? null,
      JSON.stringify(input.detailFlags ?? []),
    ]),
  );
  return {
    reference: String(r.reference),
    targetType: r.targetType as ReportTargetType,
    targetId: String(r.targetId),
    reason: String(r.reason),
    status: r.status as ReportCaseStatus,
    createdAt: date(r.createdAt),
  };
}

export async function myReports(pool: Pool, input: Session): Promise<MyReport[]> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[] }>(c, "SELECT core.my_reports() AS r", []),
  );
  return r.items.map((i) => ({
    reference: String(i.reference),
    targetType: i.targetType as ReportTargetType,
    targetId: String(i.targetId),
    reason: String(i.reason),
    status: i.status as ReportCaseStatus,
    createdAt: date(i.createdAt),
    resolvedAt: dateOrNull(i.resolvedAt),
  }));
}

// ------------------------------------------------------------------ appeals
export async function createAppeal(
  pool: Pool,
  input: Session & { productId: string; statement: string },
): Promise<AppealView> {
  requireUuid(input.productId, "productId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ appeal: unknown }>(c, "SELECT core.appeal_create($1, $2) AS r", [input.productId, input.statement]),
  );
  return appealOf(r.appeal);
}

export async function myAppeals(pool: Pool, input: Session): Promise<AppealView[]> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: unknown[] }>(c, "SELECT core.my_appeals() AS r", []),
  );
  return r.items.map(appealOf);
}

// ------------------------------------------------------------------ blocks
export interface StoreBlock {
  companyId: string;
  handle: string | null;
  displayName: string;
  blockedAt: Date;
}

export async function myBlocks(pool: Pool, input: Session): Promise<StoreBlock[]> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[] }>(c, "SELECT core.my_blocks() AS r", []),
  );
  return r.items.map((b) => ({
    companyId: String(b.companyId),
    handle: textOrNull(b.handle),
    displayName: String(b.displayName),
    blockedAt: date(b.blockedAt),
  }));
}

export async function blockStore(pool: Pool, input: Session & { companyId: string }): Promise<void> {
  requireUuid(input.companyId, "companyId");
  await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.block_store($1) AS r", [input.companyId]),
  );
}

export async function unblockStore(pool: Pool, input: Session & { companyId: string }): Promise<void> {
  requireUuid(input.companyId, "companyId");
  await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.unblock_store($1) AS r", [input.companyId]),
  );
}

// ------------------------------------------------------------------ Super Admin
export interface ReportCaseReport {
  /** An opaque number within this case (1, 2, ...): never a user id. */
  reporter: number;
  reason: string;
  detail: string | null;
  detailFlags: string[];
  createdAt: Date;
}

export interface ReportCase {
  caseId: string;
  targetType: ReportTargetType;
  status: ReportCaseStatus;
  openedAt: Date;
  autoHidden: boolean;
  target: Record<string, unknown> | null;
  reasonCounts: Record<string, number>;
  reporterCount: number;
  qualifyingReporterCount: number;
  reports: ReportCaseReport[];
}

function caseOf(raw: Json): ReportCase {
  return {
    caseId: String(raw.caseId),
    targetType: raw.targetType as ReportTargetType,
    status: raw.status as ReportCaseStatus,
    openedAt: date(raw.openedAt),
    autoHidden: raw.autoHidden === true,
    target: (raw.target ?? null) as Record<string, unknown> | null,
    reasonCounts: Object.fromEntries(
      Object.entries((raw.reasonCounts ?? {}) as Json).map(([k, v]) => [k, Number(v)]),
    ),
    reporterCount: Number(raw.reporterCount),
    qualifyingReporterCount: Number(raw.qualifyingReporterCount),
    reports: ((raw.reports ?? []) as Json[]).map((r) => ({
      reporter: Number(r.reporter),
      reason: String(r.reason),
      detail: textOrNull(r.detail),
      detailFlags: Array.isArray(r.detailFlags) ? r.detailFlags.map(String) : [],
      createdAt: date(r.createdAt),
    })),
  };
}

export async function adminReports(
  pool: Pool,
  input: Session & { cursor?: string | null; pageSize?: number },
): Promise<{ items: ReportCase[]; nextCursor: string | null }> {
  if (input.cursor != null) requireUuid(input.cursor, "cursor");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[]; nextCursor: string | null }>(c, "SELECT core.admin_reports($1, $2) AS r", [
      input.cursor ?? null,
      input.pageSize ?? null,
    ]),
  );
  return { items: r.items.map(caseOf), nextCursor: r.nextCursor };
}

export interface CaseResolution {
  caseId: string;
  outcome: "UPHELD" | "DISMISSED";
  effect: "NONE" | "HIDDEN" | "KEPT_HIDDEN" | "RESTORED";
  productStatus: string | null;
}

export function resolveReportCase(
  pool: Pool,
  input: Session & { caseId: string; outcome: "UPHELD" | "DISMISSED"; reason: string },
): Promise<CaseResolution> {
  requireUuid(input.caseId, "caseId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<CaseResolution>(c, "SELECT core.admin_report_resolve($1, $2, $3) AS r", [
      input.caseId,
      input.outcome,
      input.reason,
    ]),
  );
}

export interface AppealResolution {
  appealId: string;
  outcome: "UPHELD" | "DENIED";
  effect: "NONE" | "RESTORED" | "RETURNED_TO_DRAFT";
  productId: string;
  productStatus: string;
}

export function resolveAppeal(
  pool: Pool,
  input: Session & { appealId: string; outcome: "UPHELD" | "DENIED"; reason: string },
): Promise<AppealResolution> {
  requireUuid(input.appealId, "appealId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<AppealResolution>(c, "SELECT core.admin_appeal_resolve($1, $2, $3) AS r", [
      input.appealId,
      input.outcome,
      input.reason,
    ]),
  );
}
