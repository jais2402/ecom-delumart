import { formatInrExact, METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from "@delulu/core";
import { actionErrorText, formatWhen } from "./admin-actions";
import { ApiError } from "./api";

/**
 * Types and wording for the console's Payment methods screen (docs/decisions.md #16 and #17). A
 * change is only ever proposed here: it joins the 24-hour, cancellable queue and the server judges
 * the end state. Money is a decimal string of paise; the person types whole rupees and the
 * conversion is integer arithmetic on bigint only (invariant 1).
 */

export interface MethodSettings {
  enabled: boolean;
  displayOrder: number;
  perAttemptLimitPaise: string | null;
  perDayLimitPaise: string | null;
  maintenanceFrom: string | null;
  maintenanceUntil: string | null;
}

export interface AdminMethod extends MethodSettings {
  method: PaymentMethod;
  version: number;
  /** The kill switch for the method; off means customers cannot use it whatever the setting says. */
  switchOn: boolean;
  inMaintenance: boolean;
  available: boolean;
  pendingActionId: string | null;
}

export interface AdminMethodsResponse {
  serverNow: string;
  delaySeconds: number;
  methods: AdminMethod[];
}

export const ORDER_RANGE = { min: 1, max: 99 } as const;
export const REASON_RANGE = { min: 5, max: 500 } as const;
/** India has no daylight saving: the store's reporting time zone is a fixed offset. */
const IST_OFFSET = "+05:30";
const IST_OFFSET_MS = 330 * 60_000;
/** Whole rupees: at most 11 digits keeps the paise value inside the server's ceiling. */
const RUPEES = /^[1-9][0-9]{0,10}$/;

export function methodLabel(method: string): string {
  return (PAYMENT_METHODS as readonly string[]).includes(method)
    ? METHOD_LABELS[method as PaymentMethod]
    : "Unknown method";
}

/** A stored limit in words: "No limit" or "₹1,00,000". */
export function limitText(paise: string | null): string {
  if (paise === null) return "No limit";
  return /^[0-9]{1,18}$/.test(paise) ? formatInrExact(BigInt(paise)) : "unknown";
}

/** A maintenance window in words: "None" or "27 Nov 2026, 10:00 am IST to 27 Nov 2026, 12:00 pm IST". */
export function maintenanceText(from: string | null, until: string | null): string {
  if (from === null || until === null) return "None";
  return `${formatWhen(from)} to ${formatWhen(until)}`;
}

export const SETTING_LABELS = {
  enabled: "Offered at checkout",
  displayOrder: "Position in the list",
  perAttemptLimitPaise: "Limit per payment",
  perDayLimitPaise: "Limit per day",
  maintenance: "Maintenance window",
} as const;

export type SettingKey = keyof typeof SETTING_LABELS;

/** The setting as rows of words, in the order the screen shows them. */
export function settingRows(s: MethodSettings): { key: SettingKey; label: string; value: string }[] {
  return [
    { key: "enabled", label: SETTING_LABELS.enabled, value: s.enabled ? "Yes" : "No, switched off" },
    { key: "displayOrder", label: SETTING_LABELS.displayOrder, value: String(s.displayOrder) },
    {
      key: "perAttemptLimitPaise",
      label: SETTING_LABELS.perAttemptLimitPaise,
      value: limitText(s.perAttemptLimitPaise),
    },
    { key: "perDayLimitPaise", label: SETTING_LABELS.perDayLimitPaise, value: limitText(s.perDayLimitPaise) },
    {
      key: "maintenance",
      label: SETTING_LABELS.maintenance,
      value: maintenanceText(s.maintenanceFrom, s.maintenanceUntil),
    },
  ];
}

/** The settings that differ between the current ones and a proposal. */
export function changedSettings(current: MethodSettings, proposed: MethodSettings): Set<SettingKey> {
  const out = new Set<SettingKey>();
  if (current.enabled !== proposed.enabled) out.add("enabled");
  if (current.displayOrder !== proposed.displayOrder) out.add("displayOrder");
  if (current.perAttemptLimitPaise !== proposed.perAttemptLimitPaise) out.add("perAttemptLimitPaise");
  if (current.perDayLimitPaise !== proposed.perDayLimitPaise) out.add("perDayLimitPaise");
  if (
    !sameInstant(current.maintenanceFrom, proposed.maintenanceFrom) ||
    !sameInstant(current.maintenanceUntil, proposed.maintenanceUntil)
  )
    out.add("maintenance");
  return out;
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** The new settings carried by a waiting `payment_method.set` action, or null when they cannot be read. */
export function proposedSettings(details: Record<string, unknown> | undefined): MethodSettings | null {
  if (!details) return null;
  const { enabled, displayOrder, perAttemptLimitPaise, perDayLimitPaise, maintenanceFrom, maintenanceUntil } =
    details;
  const limit = (v: unknown): v is string | null =>
    v === null || (typeof v === "string" && /^[0-9]{1,18}$/.test(v));
  const when = (v: unknown): v is string | null =>
    v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)));
  if (typeof enabled !== "boolean" || typeof displayOrder !== "number" || !Number.isInteger(displayOrder))
    return null;
  if (
    !limit(perAttemptLimitPaise) ||
    !limit(perDayLimitPaise) ||
    !when(maintenanceFrom) ||
    !when(maintenanceUntil)
  )
    return null;
  return { enabled, displayOrder, perAttemptLimitPaise, perDayLimitPaise, maintenanceFrom, maintenanceUntil };
}

/** "Change Delulu Card: switch off, position 2, limit per day ₹10,00,000": what a waiting action will do. */
export function methodChangeSentence(method: string, details: Record<string, unknown> | undefined): string {
  const label = methodLabel(method);
  const s = proposedSettings(details);
  if (s === null) return `Change settings of ${label}`;
  const parts = [
    s.enabled ? "offered" : "switched off",
    `position ${s.displayOrder}`,
    `per payment ${limitText(s.perAttemptLimitPaise).toLowerCase()}`,
    `per day ${limitText(s.perDayLimitPaise).toLowerCase()}`,
    s.maintenanceFrom === null
      ? "no maintenance window"
      : `maintenance ${maintenanceText(s.maintenanceFrom, s.maintenanceUntil)}`,
  ];
  return `Change ${label}: ${parts.join(", ")}`;
}

// ------------------------------------------------------------------ the propose form

export interface MethodFormInput {
  enabled: boolean;
  displayOrder: string;
  /** Whole rupees; empty means no limit. */
  perAttempt: string;
  perDay: string;
  /** "YYYY-MM-DDTHH:mm" in India time (a datetime-local value); empty means no window. */
  from: string;
  until: string;
  reason: string;
}

export type MethodFormField = "displayOrder" | "perAttempt" | "perDay" | "from" | "until" | "reason";

export interface MethodChangeBody {
  method: PaymentMethod;
  enabled: boolean;
  displayOrder: number;
  perAttemptLimitPaise: string | null;
  perDayLimitPaise: string | null;
  maintenanceFrom: string | null;
  maintenanceUntil: string | null;
  reason: string;
}

/** An ISO time as a datetime-local value in India time. */
export function isoToIstInput(iso: string | null): string {
  if (iso === null) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** A datetime-local value read as India time, as an ISO time with its offset; null when it is not one. */
export function istInputToIso(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  const iso = `${text}:00${IST_OFFSET}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** The form's starting values: the method's current settings, so only what is changed differs. */
export function formFromCurrent(m: MethodSettings): MethodFormInput {
  return {
    enabled: m.enabled,
    displayOrder: String(m.displayOrder),
    perAttempt: m.perAttemptLimitPaise === null ? "" : (BigInt(m.perAttemptLimitPaise) / 100n).toString(),
    perDay: m.perDayLimitPaise === null ? "" : (BigInt(m.perDayLimitPaise) / 100n).toString(),
    from: isoToIstInput(m.maintenanceFrom),
    until: isoToIstInput(m.maintenanceUntil),
    reason: "",
  };
}

function rupeesToPaise(text: string): string | null | "invalid" {
  const t = text.trim();
  if (t === "") return null;
  return RUPEES.test(t) ? (BigInt(t) * 100n).toString() : "invalid";
}

/** Checks the form in plain words and builds the request; nothing is sent when anything is wrong. */
export function buildChange(
  method: PaymentMethod,
  input: MethodFormInput,
): { ok: true; body: MethodChangeBody } | { ok: false; problems: Partial<Record<MethodFormField, string>> } {
  const problems: Partial<Record<MethodFormField, string>> = {};

  const order = input.displayOrder.trim();
  const orderNumber = /^[0-9]{1,2}$/.test(order) ? Number(order) : Number.NaN;
  if (!(orderNumber >= ORDER_RANGE.min && orderNumber <= ORDER_RANGE.max))
    problems.displayOrder = `Enter a whole number from ${ORDER_RANGE.min} to ${ORDER_RANGE.max}.`;

  const attempt = rupeesToPaise(input.perAttempt);
  const day = rupeesToPaise(input.perDay);
  if (attempt === "invalid") problems.perAttempt = "Enter whole rupees, or leave it empty for no limit.";
  if (day === "invalid") problems.perDay = "Enter whole rupees, or leave it empty for no limit.";
  if (
    typeof attempt === "string" &&
    attempt !== "invalid" &&
    typeof day === "string" &&
    day !== "invalid" &&
    BigInt(day) < BigInt(attempt)
  )
    problems.perDay = "The daily limit cannot be lower than the limit per payment.";

  const hasFrom = input.from.trim() !== "";
  const hasUntil = input.until.trim() !== "";
  const from = hasFrom ? istInputToIso(input.from) : null;
  const until = hasUntil ? istInputToIso(input.until) : null;
  if (hasFrom && from === null) problems.from = "Enter a date and time.";
  if (hasUntil && until === null) problems.until = "Enter a date and time.";
  if (hasFrom !== hasUntil) {
    if (!hasFrom) problems.from = "A maintenance window needs a start as well as an end.";
    else problems.until = "A maintenance window needs an end as well as a start.";
  } else if (from !== null && until !== null && Date.parse(until) <= Date.parse(from)) {
    problems.until = "The window must end after it starts.";
  }

  const reasonLength = [...input.reason.trim()].length;
  if (reasonLength < REASON_RANGE.min)
    problems.reason = `Give a reason of at least ${REASON_RANGE.min} characters.`;
  else if (reasonLength > REASON_RANGE.max) problems.reason = `Use ${REASON_RANGE.max} characters or fewer.`;

  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return {
    ok: true,
    body: {
      method,
      enabled: input.enabled,
      displayOrder: orderNumber,
      perAttemptLimitPaise: attempt === "invalid" ? null : attempt,
      perDayLimitPaise: day === "invalid" ? null : day,
      maintenanceFrom: from,
      maintenanceUntil: until,
      reason: input.reason.trim(),
    },
  };
}

/** The server's refusal of a proposal, in plain words. A change that would leave no usable method gets its own sentence. */
export function methodErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "CONFIG_VALUE_INVALID") {
    const message = error.message;
    if (/stay usable/i.test(message))
      return "This change was refused: it would leave customers with no payment method they can use. At least one method must stay switched on, outside any maintenance window, with limits above the minimum. Change another method first, or keep this one on.";
    if (message.length > 0 && message.length <= 300)
      return `This change was refused: ${message.charAt(0).toLowerCase()}${message.slice(1)}${/[.!?]$/.test(message) ? "" : "."}`;
  }
  if (error instanceof ApiError && error.code === "CONFLICT")
    return "That change is the same as the current settings, or another change to this method is already waiting.";
  if (error instanceof ApiError && error.code === "CONFIG_KEY_UNKNOWN")
    return "That payment method cannot be changed here.";
  return actionErrorText(error);
}
