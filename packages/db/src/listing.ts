/**
 * Player listings (migrations 0035-0037): the owner's studio and stock commands, and the Super
 * Admin's moderation, all run as app_web for the caller's sign-in session. The database derives
 * the owner (or the Super Admin) from that session, checks every rule itself and refuses another
 * company's listing as NOT_FOUND. Listing text is not screened here or by the web server: the job
 * runner screens each submitted revision (jobs.ts). Money is bigint paise.
 */
import type { Pool } from "pg";
import type { Page } from "./account";
import { asWeb, one, requireUuid } from "./command";

export type ListingStatus =
  | "DRAFT"
  | "SCREENING"
  | "NEEDS_REVIEW"
  | "PUBLISHED"
  | "REJECTED"
  | "HIDDEN"
  | "ARCHIVED";
export type ListingInventoryMode = "STANDARD_STOCKED" | "EXCLUSIVE";
export type ListingNextAction =
  | "SUBMIT"
  | "ALLOCATE_STOCK"
  | "WAIT_FOR_SCREENING"
  | "WAIT_FOR_REVIEW"
  | "EDIT_AND_RESUBMIT"
  | "HIDDEN_BY_MODERATION"
  | "WAIT_FOR_REVISION"
  | "RESTOCK"
  | "NONE";

export interface FieldCode {
  field: string;
  code: string;
}

export interface ListingVersion {
  versionId: string;
  revision: number;
  name: string;
  hook: string | null;
  description: string;
  altText: string;
  templateId: number;
  pricePaise: bigint;
  createdAt: Date;
}

export interface ListingSubmissionView {
  submissionId: string;
  kind: "FIRST" | "REVISION";
  state: "SCREENING" | "NEEDS_REVIEW";
  submittedAt: Date;
  reasons: FieldCode[];
  version: ListingVersion;
}

export interface ListingDecision {
  kind: "FIRST" | "REVISION";
  state: "APPROVED" | "REJECTED";
  versionId: string;
  reasons: FieldCode[];
  /** The Super Admin's reason (never personal data); null for a screening decision. */
  reason: string | null;
  decidedBy: "SCREENING" | "SUPER_ADMIN" | "OWNER" | null;
  decidedAt: Date | null;
}

export interface Listing {
  productId: string;
  status: ListingStatus;
  category: string;
  inventoryMode: ListingInventoryMode;
  /** STANDARD_STOCKED: the units to allocate at publication; EXCLUSIVE: the edition's supply. */
  quantity: number | null;
  offersExpress: boolean;
  freeStandardDelivery: boolean;
  approvedNeedsStock: boolean;
  createdAt: Date;
  updatedAt: Date | null;
  publishedAt: Date | null;
  /** The draft's latest revision, or the live version of a published listing. */
  current: ListingVersion | null;
  /** The version buyers see (published listings only). */
  live: ListingVersion | null;
  /** The revision waiting for screening or review. */
  pending: ListingSubmissionView | null;
  lastDecision: ListingDecision | null;
  moderationReason: string | null;
  stock: { available: number; issued: number; retired: number };
  edition: { supply: number; issued: number } | null;
  nextAction: ListingNextAction;
  sale: SaleView;
}

export interface AppealView {
  appealId: string;
  productId: string;
  /** REJECTION: a rejected first submission; HIDE: a hide by moderation or by reports. */
  kind: "REJECTION" | "HIDE";
  status: "OPEN" | "UPHELD" | "DENIED";
  statement: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionReason: string | null;
  productName: string | null;
}

/**
 * The owner's view of a listing's sale (migration 0081). While a sale is open `listPaise` is the
 * price it returns to and `salePaise` the live price. `referencePaise` is the "was" price buyers
 * see now (null when none may be shown); `canShowReference` says whether a lower price set now
 * would carry one (the current price has been published for the required continuous hours).
 */
export interface SaleView {
  active: boolean;
  listPaise: bigint | null;
  salePaise: bigint | null;
  startedAt: Date | null;
  referencePaise: bigint | null;
  canShowReference: boolean;
}

export type PriceChangeReason =
  | "PUBLISHED"
  | "PRICE_CHANGE"
  | "REVISION"
  | "SALE_START"
  | "SALE_CHANGE"
  | "SALE_END";

export interface ListingDetail extends Listing {
  /** The listing's latest appeal (migration 0039), or null. */
  appeal: AppealView | null;
  /** The listing was rejected or hidden by moderation and that decision has not been appealed. */
  appealable: boolean;
  versions: (ListingVersion & {
    isCurrent: boolean;
    submissions: {
      kind: string;
      state: string;
      reasons: FieldCode[];
      reason: string | null;
      decidedBy: string | null;
      submittedAt: Date;
      decidedAt: Date | null;
    }[];
  })[];
  priceHistory: {
    versionId: string;
    pricePaise: bigint;
    previousPaise: bigint | null;
    reason: PriceChangeReason;
    changedAt: Date;
  }[];
}

export interface DraftInput {
  name: string;
  hook?: string | null;
  description: string;
  category: string;
  templateId: number;
  altText?: string;
  pricePaise: bigint;
  inventoryMode: ListingInventoryMode;
  quantity: number;
  offersExpress?: boolean;
  freeStandardDelivery?: boolean;
}

export type DraftChanges = Partial<DraftInput>;

export interface RevisionInput {
  name?: string;
  hook?: string | null;
  description?: string;
  altText?: string;
  templateId?: number;
}

// ------------------------------------------------------------------ parsing
type Json = Record<string, unknown>;

const date = (v: unknown): Date => new Date(String(v));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const reasonsOf = (v: unknown): FieldCode[] =>
  Array.isArray(v)
    ? v.map((r) => ({ field: String((r as Json).field), code: String((r as Json).code) }))
    : [];

function versionOf(v: unknown): ListingVersion | null {
  if (v === null || v === undefined) return null;
  const j = v as Json;
  return {
    versionId: String(j.versionId),
    revision: Number(j.revision),
    name: String(j.name),
    hook: j.hook === null ? null : String(j.hook),
    description: String(j.description),
    altText: String(j.altText),
    templateId: Number(j.templateId),
    pricePaise: BigInt(String(j.pricePaise)),
    createdAt: date(j.createdAt),
  };
}

function listingOf(raw: unknown): Listing {
  const j = raw as Json;
  const pending = j.pending as Json | null;
  const decision = j.lastDecision as Json | null;
  const stock = j.stock as Json;
  const edition = j.edition as Json | null;
  return {
    productId: String(j.productId),
    status: j.status as ListingStatus,
    category: String(j.category),
    inventoryMode: j.inventoryMode as ListingInventoryMode,
    quantity: j.quantity === null ? null : Number(j.quantity),
    offersExpress: j.offersExpress === true,
    freeStandardDelivery: j.freeStandardDelivery === true,
    approvedNeedsStock: j.approvedNeedsStock === true,
    createdAt: date(j.createdAt),
    updatedAt: dateOrNull(j.updatedAt),
    publishedAt: dateOrNull(j.publishedAt),
    current: versionOf(j.current),
    live: versionOf(j.live),
    pending: pending
      ? {
          submissionId: String(pending.submissionId),
          kind: pending.kind as "FIRST" | "REVISION",
          state: pending.state as "SCREENING" | "NEEDS_REVIEW",
          submittedAt: date(pending.submittedAt),
          reasons: reasonsOf(pending.reasons),
          version: versionOf(pending.version) as ListingVersion,
        }
      : null,
    lastDecision: decision
      ? {
          kind: decision.kind as "FIRST" | "REVISION",
          state: decision.state as "APPROVED" | "REJECTED",
          versionId: String(decision.versionId),
          reasons: reasonsOf(decision.reasons),
          reason: decision.reason === null ? null : String(decision.reason),
          decidedBy: (decision.decidedBy ?? null) as ListingDecision["decidedBy"],
          decidedAt: dateOrNull(decision.decidedAt),
        }
      : null,
    moderationReason: j.moderationReason === null ? null : String(j.moderationReason),
    stock: {
      available: Number(stock.available),
      issued: Number(stock.issued),
      retired: Number(stock.retired),
    },
    edition: edition ? { supply: Number(edition.supply), issued: Number(edition.issued) } : null,
    nextAction: j.nextAction as ListingNextAction,
    sale: saleOf(j.sale),
  };
}

function saleOf(raw: unknown): SaleView {
  const j = (raw ?? {}) as Json;
  const money = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(String(v)));
  return {
    active: j.active === true,
    listPaise: money(j.listPaise),
    salePaise: money(j.salePaise),
    startedAt: dateOrNull(j.startedAt),
    referencePaise: money(j.referencePaise),
    canShowReference: j.canShowReference === true,
  };
}

export function appealOf(raw: unknown): AppealView {
  const a = raw as Json;
  return {
    appealId: String(a.appealId),
    productId: String(a.productId),
    kind: a.kind as AppealView["kind"],
    status: a.status as AppealView["status"],
    statement: String(a.statement),
    createdAt: date(a.createdAt),
    decidedAt: dateOrNull(a.decidedAt),
    decisionReason:
      a.decisionReason === null || a.decisionReason === undefined ? null : String(a.decisionReason),
    productName: a.productName === null || a.productName === undefined ? null : String(a.productName),
  };
}

function detailOf(raw: unknown): ListingDetail {
  const j = raw as Json;
  return {
    ...listingOf(raw),
    appeal: j.appeal === null || j.appeal === undefined ? null : appealOf(j.appeal),
    appealable: j.appealable === true,
    versions: (j.versions as Json[]).map((v) => ({
      ...(versionOf(v) as ListingVersion),
      isCurrent: v.isCurrent === true,
      submissions: (v.submissions as Json[]).map((s) => ({
        kind: String(s.kind),
        state: String(s.state),
        reasons: reasonsOf(s.reasons),
        reason: s.reason === null ? null : String(s.reason),
        decidedBy: s.decidedBy === null ? null : String(s.decidedBy),
        submittedAt: date(s.submittedAt),
        decidedAt: dateOrNull(s.decidedAt),
      })),
    })),
    priceHistory: (j.priceHistory as Json[]).map((h) => ({
      versionId: String(h.versionId),
      pricePaise: BigInt(String(h.pricePaise)),
      previousPaise: h.previousPaise === null ? null : BigInt(String(h.previousPaise)),
      reason: h.reason as PriceChangeReason,
      changedAt: date(h.changedAt),
    })),
  };
}

interface Session {
  authSessionId: string;
}

async function productCommand(
  pool: Pool,
  authSessionId: string,
  sql: string,
  params: unknown[],
): Promise<ListingDetail> {
  const r = await asWeb(pool, authSessionId, (c) => one<{ product: unknown }>(c, sql, params));
  return detailOf(r.product);
}

// ------------------------------------------------------------------ reads
export async function myProducts(
  pool: Pool,
  input: Session & { status?: ListingStatus | null; cursor?: string | null; pageSize?: number },
): Promise<Page<Listing, string>> {
  if (input.cursor != null) requireUuid(input.cursor, "cursor");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: unknown[]; nextCursor: string | null }>(c, "SELECT core.my_products($1, $2, $3) AS r", [
      input.status ?? null,
      input.cursor ?? null,
      input.pageSize ?? null,
    ]),
  );
  return { items: r.items.map(listingOf), nextCursor: r.nextCursor };
}

export async function myProduct(pool: Pool, input: Session & { productId: string }): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<unknown>(c, "SELECT core.my_product($1) AS r", [input.productId]),
  );
  return detailOf(r);
}

// ------------------------------------------------------------------ drafts
export function createDraft(pool: Pool, input: Session & { draft: DraftInput }): Promise<ListingDetail> {
  const d = input.draft;
  return productCommand(
    pool,
    input.authSessionId,
    "SELECT core.draft_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r",
    [
      d.name,
      d.hook ?? null,
      d.description,
      d.category,
      d.templateId,
      d.altText ?? "",
      d.pricePaise.toString(),
      d.inventoryMode,
      d.quantity,
      d.offersExpress ?? false,
      d.freeStandardDelivery ?? false,
    ],
  );
}

/** Changes a draft; an omitted field is unchanged and an empty hook clears it. */
export function updateDraft(
  pool: Pool,
  input: Session & { productId: string; changes: DraftChanges },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  const d = input.changes;
  return productCommand(
    pool,
    input.authSessionId,
    "SELECT core.draft_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r",
    [
      input.productId,
      d.name ?? null,
      d.hook === undefined ? null : (d.hook ?? ""),
      d.description ?? null,
      d.category ?? null,
      d.templateId ?? null,
      d.altText ?? null,
      d.pricePaise === undefined ? null : d.pricePaise.toString(),
      d.inventoryMode ?? null,
      d.quantity ?? null,
      d.offersExpress ?? null,
      d.freeStandardDelivery ?? null,
    ],
  );
}

export async function deleteDraft(pool: Pool, input: Session & { productId: string }): Promise<void> {
  requireUuid(input.productId, "productId");
  await asWeb(pool, input.authSessionId, (c) =>
    one<unknown>(c, "SELECT core.draft_delete($1) AS r", [input.productId]),
  );
}

// ------------------------------------------------------------------ submission and live listings
export function submitProduct(pool: Pool, input: Session & { productId: string }): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_submit($1) AS r", [input.productId]);
}

export function reviseProduct(
  pool: Pool,
  input: Session & { productId: string; revision: RevisionInput },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  const v = input.revision;
  return productCommand(
    pool,
    input.authSessionId,
    "SELECT core.product_revise($1, $2, $3, $4, $5, $6) AS r",
    [
      input.productId,
      v.name ?? null,
      v.hook === undefined ? null : (v.hook ?? ""),
      v.description ?? null,
      v.altText ?? null,
      v.templateId ?? null,
    ],
  );
}

export function setProductPrice(
  pool: Pool,
  input: Session & { productId: string; pricePaise: bigint },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_set_price($1, $2) AS r", [
    input.productId,
    input.pricePaise.toString(),
  ]);
}

/**
 * Puts a live listing on sale (migration 0081). `requireReference`: refuse with
 * REFERENCE_PRICE_INELIGIBLE, changing nothing, when no earlier price qualifies to show as the
 * struck-through "was" price.
 */
export function setSalePrice(
  pool: Pool,
  input: Session & { productId: string; salePricePaise: bigint; requireReference?: boolean },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_set_sale_price($1, $2, $3) AS r", [
    input.productId,
    input.salePricePaise.toString(),
    input.requireReference === true,
  ]);
}

/** Ends the sale: the list price is the live price again. */
export function endSale(pool: Pool, input: Session & { productId: string }): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_end_sale($1) AS r", [
    input.productId,
  ]);
}

export function restockProduct(
  pool: Pool,
  input: Session & { productId: string; quantity: number },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_restock($1, $2) AS r", [
    input.productId,
    input.quantity,
  ]);
}

export interface RetireResult {
  product: ListingDetail;
  retired: number;
  /** EXCLUSIVE: the most this edition can now ever sell (issued + still available). */
  sellableSupply: number | null;
}

export async function retireUnits(
  pool: Pool,
  input: Session & { productId: string; quantity: number },
): Promise<RetireResult> {
  requireUuid(input.productId, "productId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ product: unknown; retired: number; sellableSupply: number | null }>(
      c,
      "SELECT core.product_retire_units($1, $2) AS r",
      [input.productId, input.quantity],
    ),
  );
  return {
    product: detailOf(r.product),
    retired: Number(r.retired),
    sellableSupply: r.sellableSupply === null ? null : Number(r.sellableSupply),
  };
}

/** Publishes an approved listing that waited for stock (optionally with a lower quantity). */
export function allocateAndPublish(
  pool: Pool,
  input: Session & { productId: string; quantity?: number | null },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_allocate_and_publish($1, $2) AS r", [
    input.productId,
    input.quantity ?? null,
  ]);
}

export function archiveProduct(pool: Pool, input: Session & { productId: string }): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_archive($1) AS r", [input.productId]);
}

export function setProductShipping(
  pool: Pool,
  input: Session & { productId: string; offersExpress?: boolean; freeStandardDelivery?: boolean },
): Promise<ListingDetail> {
  requireUuid(input.productId, "productId");
  return productCommand(pool, input.authSessionId, "SELECT core.product_set_shipping($1, $2, $3) AS r", [
    input.productId,
    input.offersExpress ?? null,
    input.freeStandardDelivery ?? null,
  ]);
}

export interface WarehouseView {
  id: string;
  kind: "STARTER" | "PURCHASED";
  capacity: number;
  used: number;
  zapHub: boolean;
}

export async function setZapHub(
  pool: Pool,
  input: Session & { warehouseId: string; enabled: boolean },
): Promise<WarehouseView[]> {
  requireUuid(input.warehouseId, "warehouseId");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ warehouses: WarehouseView[] }>(c, "SELECT core.warehouse_set_zap_hub($1, $2) AS r", [
      input.warehouseId,
      input.enabled,
    ]),
  );
  return r.warehouses.map((w) => ({
    id: w.id,
    kind: w.kind,
    capacity: Number(w.capacity),
    used: Number(w.used),
    zapHub: w.zapHub === true,
  }));
}

// ------------------------------------------------------------------ Super Admin
export interface ModerationItem {
  submissionId: string;
  productId: string;
  versionId: string;
  kind: "FIRST" | "REVISION";
  submittedAt: Date;
  reasons: FieldCode[];
  store: { handle: string | null; displayName: string };
  category: string;
  inventoryMode: ListingInventoryMode;
  productStatus: ListingStatus;
  version: ListingVersion;
}

export interface AppealQueueItem {
  appealId: string;
  productId: string;
  kind: "REJECTION" | "HIDE";
  statement: string;
  createdAt: Date;
  productStatus: ListingStatus;
  store: { handle: string | null; displayName: string };
  version: ListingVersion | null;
  /** The decision appealed: the action, its reason and who made it. */
  decision: {
    action: "HIDDEN" | "REJECTED";
    reason: string | null;
    at: Date | null;
    by: string | null;
  } | null;
  /** The evidence: screening reasons, and the report case's reason counts (reporters never named). */
  evidence: {
    reasons: FieldCode[];
    reports: { caseId: string; reasonCounts: Record<string, number>; reporterCount: number } | null;
  };
}

export interface ModerationQueue extends Page<ModerationItem, string> {
  /** Open appeals, oldest first (migration 0039). */
  appeals: AppealQueueItem[];
}

function appealQueueItemOf(raw: unknown): AppealQueueItem {
  const a = raw as Json;
  const d = a.decision as Json | null;
  const e = (a.evidence ?? {}) as Json;
  const reports = e.reports as Json | null | undefined;
  return {
    appealId: String(a.appealId),
    productId: String(a.productId),
    kind: a.kind as AppealQueueItem["kind"],
    statement: String(a.statement),
    createdAt: date(a.createdAt),
    productStatus: a.productStatus as ListingStatus,
    store: a.store as { handle: string | null; displayName: string },
    version: versionOf(a.version),
    decision: d
      ? {
          action: d.action as "HIDDEN" | "REJECTED",
          reason: d.reason === null || d.reason === undefined ? null : String(d.reason),
          at: dateOrNull(d.at),
          by: d.by === null || d.by === undefined ? null : String(d.by),
        }
      : null,
    evidence: {
      reasons: reasonsOf(e.reasons),
      reports: reports
        ? {
            caseId: String(reports.caseId),
            reasonCounts: Object.fromEntries(
              Object.entries((reports.reasonCounts ?? {}) as Json).map(([k, v]) => [k, Number(v)]),
            ),
            reporterCount: Number(reports.reporterCount),
          }
        : null,
    },
  };
}

export async function moderationQueue(
  pool: Pool,
  input: Session & { cursor?: string | null; pageSize?: number },
): Promise<ModerationQueue> {
  if (input.cursor != null) requireUuid(input.cursor, "cursor");
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<{ items: Json[]; nextCursor: string | null; appeals: unknown[] }>(
      c,
      "SELECT core.admin_moderation_queue($1, $2) AS r",
      [input.cursor ?? null, input.pageSize ?? null],
    ),
  );
  return {
    items: r.items.map((i) => ({
      submissionId: String(i.submissionId),
      productId: String(i.productId),
      versionId: String(i.versionId),
      kind: i.kind as "FIRST" | "REVISION",
      submittedAt: date(i.submittedAt),
      reasons: reasonsOf(i.reasons),
      store: i.store as { handle: string | null; displayName: string },
      category: String(i.category),
      inventoryMode: i.inventoryMode as ListingInventoryMode,
      productStatus: i.productStatus as ListingStatus,
      version: versionOf(i.version) as ListingVersion,
    })),
    nextCursor: r.nextCursor,
    appeals: r.appeals.map(appealQueueItemOf),
  };
}

export interface ModerationOutcome {
  outcome: "PUBLISHED" | "NEEDS_STOCK" | "REVISED" | "REJECTED" | "HIDDEN";
  productId: string;
  versionId?: string;
}

export function decideListing(
  pool: Pool,
  input: Session & { productId: string; versionId: string; decision: "APPROVE" | "REJECT"; reason: string },
): Promise<ModerationOutcome> {
  requireUuid(input.productId, "productId");
  requireUuid(input.versionId, "versionId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<ModerationOutcome>(c, "SELECT core.admin_listing_decide($1, $2, $3, $4) AS r", [
      input.productId,
      input.versionId,
      input.decision,
      input.reason,
    ]),
  );
}

export function hideListing(
  pool: Pool,
  input: Session & { productId: string; reason: string },
): Promise<ModerationOutcome> {
  requireUuid(input.productId, "productId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<ModerationOutcome>(c, "SELECT core.admin_listing_hide($1, $2) AS r", [input.productId, input.reason]),
  );
}

export function restoreListing(
  pool: Pool,
  input: Session & { productId: string; reason: string },
): Promise<ModerationOutcome> {
  requireUuid(input.productId, "productId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<ModerationOutcome>(c, "SELECT core.admin_listing_restore($1, $2) AS r", [
      input.productId,
      input.reason,
    ]),
  );
}

export function setSystemSwitch(
  pool: Pool,
  input: Session & { name: string; enabled: boolean; reason: string },
): Promise<{ name: string; enabled: boolean }> {
  return asWeb(pool, input.authSessionId, (c) =>
    one<{ name: string; enabled: boolean }>(c, "SELECT core.admin_set_switch($1, $2, $3) AS r", [
      input.name,
      input.enabled,
      input.reason,
    ]),
  );
}

export interface ModerationOverdue {
  /** NEEDS_REVIEW submissions older than the threshold. */
  count: number;
  /** Age of the oldest NEEDS_REVIEW submission, in whole seconds; null when none is waiting. */
  oldestAgeSeconds: number | null;
  oldestSubmittedAt: Date | null;
  thresholdHours: number;
}

export interface AdminStatus {
  publication: { enabled: boolean; updatedAt: Date | null };
  moderationOverdue: ModerationOverdue;
  /**
   * Submissions stuck in SCREENING (seventh review, 0057): `count` older than the threshold, the
   * age of the oldest one in SCREENING. Same shape as moderationOverdue.
   */
  screeningStalled: ModerationOverdue;
  needsReview: number;
  openReportCases: number;
  openAppeals: number;
}

export function moderationOverdueOf(v: unknown): ModerationOverdue {
  const o = (v ?? {}) as Json;
  return {
    count: Number(o.count ?? 0),
    oldestAgeSeconds:
      o.oldestAgeSeconds === null || o.oldestAgeSeconds === undefined ? null : Number(o.oldestAgeSeconds),
    oldestSubmittedAt: o.oldestSubmittedAt ? date(o.oldestSubmittedAt) : null,
    thresholdHours: Number(o.thresholdHours ?? 0),
  };
}

/** The console's status (Super Admin only; FORBIDDEN for anyone else, 0046). */
export async function adminStatus(pool: Pool, input: Session): Promise<AdminStatus> {
  const r = await asWeb(pool, input.authSessionId, (c) =>
    one<Json>(c, "SELECT core.admin_status() AS r", []),
  );
  const p = (r.publication ?? {}) as Json;
  return {
    publication: { enabled: p.enabled === true, updatedAt: p.updatedAt ? date(p.updatedAt) : null },
    moderationOverdue: moderationOverdueOf(r.moderationOverdue),
    screeningStalled: moderationOverdueOf(r.screeningStalled),
    needsReview: Number(r.needsReview ?? 0),
    openReportCases: Number(r.openReportCases ?? 0),
    openAppeals: Number(r.openAppeals ?? 0),
  };
}
