/**
 * The Super Admin's delayed, cancellable actions and versioned configuration (migration 0090;
 * PRD R16.6, US-60; docs/decisions.md #16). The web calls run as app_web for the admin's session;
 * each database function checks the Super Admin itself and answers FORBIDDEN to anyone else. The
 * proposal is validated here with the shared allow-list first (@delulu/core) and again by the
 * database. The executor step (jobs role) is `executeDueAdminActions` in ./jobs.
 */
import { type AdminActionKind, type AdminActionState, DomainError, validateConfigValue } from "@delulu/core";
import type { Pool } from "pg";
import { asWeb, one, requireUuid } from "./command";

export { executeDueAdminActions } from "./jobs";

interface Session {
  authSessionId: string;
}

/** What an action did when it ran. The code is a stable refusal code or INTERNAL; never a message. */
export interface AdminActionOutcome {
  code?: string;
  changed?: boolean;
  configVersion?: number;
}

/** One action as the console shows it. Names no user. Money is a decimal string (invariant 1). */
export interface AdminActionView {
  id: string;
  kind: AdminActionKind | string;
  /** The configuration key of a `config.set` action. */
  key: string | null;
  value: string | null;
  reason: string | null;
  state: AdminActionState;
  proposedAt: string;
  notBefore: string;
  /** Whole seconds until it is due, while it waits; null otherwise. */
  secondsLeft: number | null;
  executedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  outcome: AdminActionOutcome | null;
  canCancel: boolean;
}

export type AdminActionScope = "OPEN" | "HISTORY" | "ALL";

export interface AdminActionPage {
  items: AdminActionView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** The database's clock when the page was read, for the countdown. */
  serverNow: string;
}

export interface ConfigKeyView {
  key: string;
  kind: "percent" | "paise";
  min: string;
  max: string;
  default: string;
  /** The value orders are placed under now (decimal string). */
  current: string;
  /** The waiting change to this key, if any. */
  pendingActionId: string | null;
}

export interface ConfigOverview {
  version: number;
  effectiveFrom: string;
  delaySeconds: number;
  serverNow: string;
  keys: ConfigKeyView[];
}

export interface Announcement {
  id: string;
  key: string;
  /** The new value as a decimal string. */
  value: string;
  effectiveFrom: string;
  announcedAt: string;
}

/**
 * Proposes changing one allow-listed configuration value. It waits for the configured delay
 * (24 hours) and can be cancelled until it runs. Needs a recent sign-in (REAUTH_REQUIRED).
 */
export async function proposeConfigChange(
  pool: Pool,
  input: Session & { key: string; value: string; reason: string },
): Promise<AdminActionView> {
  // the same allow-list and bounds as the database; nothing else reaches it
  validateConfigValue(input.key, input.value);
  return asWeb(pool, input.authSessionId, (c) =>
    one<AdminActionView>(c, "SELECT core.admin_action_propose($1, $2::jsonb, $3) AS r", [
      "config.set",
      JSON.stringify({ key: input.key, value: input.value }),
      input.reason,
    ]),
  );
}

/** Cancels an action that has not run yet. CONFLICT once it has run or was cancelled. */
export function cancelAdminAction(
  pool: Pool,
  input: Session & { actionId: string; reason: string },
): Promise<AdminActionView> {
  requireUuid(input.actionId, "actionId");
  return asWeb(pool, input.authSessionId, (c) =>
    one<AdminActionView>(c, "SELECT core.admin_action_cancel($1, $2) AS r", [input.actionId, input.reason]),
  );
}

export function adminActions(
  pool: Pool,
  input: Session & { scope: AdminActionScope; page: number },
): Promise<AdminActionPage> {
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new DomainError("VALIDATION_FAILED", "page is a whole number from 1");
  }
  return asWeb(pool, input.authSessionId, (c) =>
    one<AdminActionPage>(c, "SELECT core.admin_actions($1, $2) AS r", [input.scope, input.page]),
  );
}

export function adminConfigOverview(pool: Pool, input: Session): Promise<ConfigOverview> {
  return asWeb(pool, input.authSessionId, (c) =>
    one<ConfigOverview>(c, "SELECT core.admin_config_overview() AS r", []),
  );
}

/** The economy changes announced lately, newest first. Public: no session, no person, no reason. */
export function publicAnnouncements(pool: Pool): Promise<Announcement[]> {
  return asWeb(pool, null, (c) => one<Announcement[]>(c, "SELECT core.public_announcements() AS r", []));
}
