import {
  type AdminActionState,
  CONFIG_KEYS,
  type ConfigKeySpec,
  configKeySpec,
  describeConfigValue,
  validateConfigValue,
} from "@delulu/core";
import { ApiError } from "./api";
import { studioErrorText } from "./studio";

/**
 * Types and wording for the console's Pending actions and Configuration pages (docs/decisions.md
 * #15). Money is a decimal string of paise; the person types whole rupees and the conversion is
 * integer arithmetic on bigint only (invariant 1).
 */

export interface AdminActionItem {
  id: string;
  kind: string;
  key: string | null;
  value: string | null;
  /** A `payment_method.set` action's new settings (limits as decimal strings); absent for other kinds. */
  details?: Record<string, unknown>;
  reason: string | null;
  state: AdminActionState;
  proposedAt: string;
  notBefore: string;
  secondsLeft: number | null;
  executedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  outcome: { code?: string; changed?: boolean; configVersion?: number } | null;
  canCancel: boolean;
}

export interface AdminActionsResponse {
  items: AdminActionItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  serverNow: string;
}

export interface ConfigKeyItem {
  key: string;
  kind: "percent" | "paise";
  min: string;
  max: string;
  default: string;
  current: string;
  pendingActionId: string | null;
}

export interface ConfigOverviewResponse {
  version: number;
  effectiveFrom: string;
  delaySeconds: number;
  serverNow: string;
  keys: ConfigKeyItem[];
}

export interface AnnouncementItem {
  id: string;
  key: string;
  value: string;
  effectiveFrom: string;
  announcedAt: string;
}

export const ALLOWED_KEYS: readonly ConfigKeySpec[] = CONFIG_KEYS;

/** "Set Marketplace fee to 7%": what the action will do, in words. */
export function actionSentence(a: Pick<AdminActionItem, "kind" | "key" | "value">): string {
  if (a.kind !== "config.set" || a.key === null || a.value === null) return "Unknown action";
  const spec = configKeySpec(a.key);
  if (spec === undefined || !/^[0-9]{1,18}$/.test(a.value)) return "Unknown action";
  return `Set ${spec.label} to ${describeConfigValue(spec, BigInt(a.value))}`;
}

/** A stored value in words: "5%" or "₹1,000". */
export function valueText(spec: ConfigKeySpec, stored: string): string {
  return /^[0-9]{1,18}$/.test(stored) ? describeConfigValue(spec, BigInt(stored)) : "unknown";
}

/**
 * What the person typed (whole rupees for money, a whole percent otherwise) as the value the API
 * takes (paise as a decimal string), or null when it is not a plain whole number within the key's
 * bounds. No floating point.
 */
export function inputToStoredValue(spec: ConfigKeySpec, text: string): string | null {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(text)) return null;
  const stored = spec.kind === "paise" ? (BigInt(text) * 100n).toString() : text;
  try {
    validateConfigValue(spec.key, stored);
  } catch {
    return null;
  }
  return stored;
}

/** A stored value in the unit the person types: whole rupees for money. */
export function storedValueToInput(spec: ConfigKeySpec, stored: string): string {
  if (!/^[0-9]{1,18}$/.test(stored)) return "";
  return spec.kind === "paise" ? (BigInt(stored) / 100n).toString() : stored;
}

export function stateBadge(state: AdminActionState): {
  tone: "info" | "success" | "neutral" | "danger";
  label: string;
} {
  switch (state) {
    case "QUEUED":
      return { tone: "info", label: "Waiting" };
    case "EXECUTED":
      return { tone: "success", label: "Applied" };
    case "CANCELLED":
      return { tone: "neutral", label: "Cancelled" };
    case "FAILED":
      return { tone: "danger", label: "Failed" };
  }
}

const ERRORS: Record<string, string> = {
  REAUTH_REQUIRED:
    "For safety, a change needs a recent sign-in. Sign out, sign in again, then try once more.",
  CONFLICT: "That change is already waiting, is already the current value, or has already run.",
  ADMIN_ACTION_LIMIT: "Too many changes are waiting. Cancel one or wait for one to run first.",
  CONFIG_VALUE_INVALID: "That value is outside the allowed range for this setting.",
  CONFIG_KEY_UNKNOWN: "That setting cannot be changed here.",
  ADMIN_ACTION_UNKNOWN: "That kind of action is not allowed.",
  VALIDATION_FAILED:
    "Check the value and give a reason of 5 to 500 characters, with no links or contact details.",
  NOT_FOUND: "That action was not found.",
};

export function actionErrorText(error: unknown): string {
  if (error instanceof ApiError && ERRORS[error.code]) return ERRORS[error.code] as string;
  return studioErrorText(error);
}

/** A moment in the store's reporting time zone, e.g. "27 Nov 2026, 10:30 am IST". */
export function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown time";
  const text = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(t));
  return `${text} IST`;
}
