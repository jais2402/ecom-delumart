import { RANGE_MAX_DAYS, validateDateRange } from "@delulu/core";

/** The date range of an analytics screen. It lives in the URL (?from&to) so it can be shared. */
export type Range = { from: string; to: string };

export const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export function defaultRange(today: string, days: number = DEFAULT_DAYS): Range {
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/** A range from the URL, or the default when it is missing, malformed, reversed, future or too long. */
export function parseRange(params: { get(name: string): string | null }, today: string): Range {
  const from = params.get("from");
  const to = params.get("to");
  if (from === null || to === null) return defaultRange(today);
  try {
    validateDateRange(from, to, RANGE_MAX_DAYS);
  } catch {
    return defaultRange(today);
  }
  if (to > today) return defaultRange(today);
  return { from, to };
}

/** Builds a query string, leaving out empty values. */
export function queryString(values: Record<string, string | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) out.set(key, value);
  return out.toString();
}

/** "21 Nov 2026" for a UTC day. */
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "21 Nov" for an axis. */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Local-time stamp for "as of". */
export function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
