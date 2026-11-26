import "./server-only";
import type { AdminActionPage, AdminActionView, Announcement, ConfigOverview } from "@delulu/db/runtime";
import { z } from "zod";

/**
 * The Super Admin's delayed actions and configuration (docs/decisions.md #15): request schemas and
 * the response shapes. Each view copies named fields only, so nothing the database adds later
 * reaches a response by accident. Money and counts are decimal strings (invariant 1). No view names
 * a user. The announcement view is the only public one: the setting and the new value, nothing else.
 */

/** POST body of a configuration change: the shared allow-list and bounds are checked below this. */
export const configChangeBody = z.strictObject({
  key: z.string().max(60),
  value: z.string().max(20),
  reason: z.string().max(1_000),
});

export const cancelBody = z.strictObject({ reason: z.string().max(1_000) });

export const actionsQuery = z.strictObject({
  scope: z.enum(["OPEN", "HISTORY", "ALL"]).optional(),
  page: z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/)
    .optional()
    .transform((v) => (v === undefined ? 1 : Number(v))),
});

export function actionView(a: AdminActionView) {
  return {
    id: a.id,
    kind: a.kind,
    key: a.key,
    value: a.value,
    reason: a.reason,
    state: a.state,
    proposedAt: a.proposedAt,
    notBefore: a.notBefore,
    secondsLeft: a.secondsLeft,
    executedAt: a.executedAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason,
    outcome:
      a.outcome === null
        ? null
        : { code: a.outcome.code, changed: a.outcome.changed, configVersion: a.outcome.configVersion },
    canCancel: a.canCancel,
  };
}

export function actionPageView(p: AdminActionPage) {
  return {
    items: p.items.map(actionView),
    page: p.page,
    pageSize: p.pageSize,
    total: p.total,
    totalPages: p.totalPages,
    serverNow: p.serverNow,
  };
}

export function configOverviewView(o: ConfigOverview) {
  return {
    version: o.version,
    effectiveFrom: o.effectiveFrom,
    delaySeconds: o.delaySeconds,
    serverNow: o.serverNow,
    keys: o.keys.map((k) => ({
      key: k.key,
      kind: k.kind,
      min: k.min,
      max: k.max,
      default: k.default,
      current: k.current,
      pendingActionId: k.pendingActionId,
    })),
  };
}

export function announcementView(a: Announcement) {
  return { id: a.id, key: a.key, value: a.value, effectiveFrom: a.effectiveFrom, announcedAt: a.announcedAt };
}
