/**
 * The Super Admin's delayed, cancellable actions and versioned configuration changes (PRD R16.6,
 * R7 Settings and Economy, R10 ConsoleConfigChange; docs/decisions.md #16). Pure: the allow-list
 * of action kinds, the allow-list of configuration keys with their bounds, and the arithmetic and
 * wording around them. The database (migration 0090) holds the same allow-lists in
 * core.config_key_registry() and core.admin_action_kinds() and enforces them again when an action
 * is proposed and again when it runs; a database test checks that the two agree.
 *
 * To add an action kind later (platform coupon budget, minting, reversal, research export): add it
 * to ADMIN_ACTION_KINDS, add its validator and executor to the database allow-list in a new
 * migration, and add its row to the console. Nothing else in the queue changes.
 */
import { DomainError } from "../errors/index";
import { formatInrExact, type Paise } from "../money/index";

/**
 * Tunables of the queue (CLAUDE.md invariant 10). The database reads the same numbers from
 * configuration keys with these defaults, clamped (migration 0090): `admin_action_delay_seconds`,
 * `admin_action_open_max`, `config_apply_grace_seconds`, `announcement_window_hours`.
 */
export const ADMIN_ACTION_RULES = {
  /** 24 hours (R16.6). Clamped to the two limits below wherever it is read. */
  delaySeconds: 86_400,
  delayMinSeconds: 3_600,
  delayMaxSeconds: 604_800,
  /** Proposals waiting at once. */
  openMax: 20,
  /**
   * A configuration version takes effect this long after it is written, so that no checkout
   * session opened while the executing transaction is still uncommitted can be priced under the
   * old version yet fall after the new version's start (the pay check compares the two).
   * Equal to the jobs role's statement timeout, so the transaction cannot outlive it.
   */
  applyGraceSeconds: 30,
  /** How long the storefront banner keeps announcing an economy change. */
  announcementWindowHours: 72,
  /** Announcements one public answer carries. */
  announcementMax: 3,
  /** Rows one console page lists. */
  pageSize: 50,
} as const;

/** Allow-listed action kinds. Anything else is refused when proposed and again when due. */
export const ADMIN_ACTION_KINDS = ["config.set"] as const;
export type AdminActionKind = (typeof ADMIN_ACTION_KINDS)[number];

export const ADMIN_ACTION_STATES = ["QUEUED", "CANCELLED", "EXECUTED", "FAILED"] as const;
export type AdminActionState = (typeof ADMIN_ACTION_STATES)[number];

export function isAdminActionKind(value: unknown): value is AdminActionKind {
  return typeof value === "string" && (ADMIN_ACTION_KINDS as readonly string[]).includes(value);
}

export type ConfigValueKind = "percent" | "paise";

export interface ConfigKeySpec {
  /** The dotted path, which is also the key the API and the audit log use. */
  key: string;
  /** Where the value sits in core.config_version.values. */
  path: readonly string[];
  /** "percent": a whole number stored as a JSON number. "paise": money, stored as a decimal string. */
  kind: ConfigValueKind;
  /** Inclusive bounds and the default the pricing code uses when the key is absent. */
  min: bigint;
  max: bigint;
  default: bigint;
  label: string;
  /** One line for the console. */
  help: string;
}

/** ₹1 lakh in paise: the ceiling of a delivery fee. */
const DELIVERY_FEE_CEILING_PAISE = 10_000_000n;

/**
 * The configuration keys the Super Admin may change through the queue, with the bounds that keep
 * checkout working: a fee is never below zero and never above its ceiling. Defaults mirror
 * DEFAULT_PRICING_CONFIG and the readers in migration 0016. Everything else in configuration
 * (grants, thresholds, price bounds, limits) is not changeable from the console in this release.
 */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: "fee_percent",
    path: ["fee_percent"],
    kind: "percent",
    min: 0n,
    max: 20n,
    default: 5n,
    label: "Marketplace fee",
    help: "The share of each sale the platform keeps, in whole percent (0 to 20).",
  },
  {
    key: "delivery_fee_paise.STANDARD",
    path: ["delivery_fee_paise", "STANDARD"],
    kind: "paise",
    min: 0n,
    max: DELIVERY_FEE_CEILING_PAISE,
    default: 100_000n,
    label: "Standard delivery fee",
    help: "Per seller order, in paise (up to ₹1,00,000).",
  },
  {
    key: "delivery_fee_paise.EXPRESS",
    path: ["delivery_fee_paise", "EXPRESS"],
    kind: "paise",
    min: 0n,
    max: DELIVERY_FEE_CEILING_PAISE,
    default: 1_000_000n,
    label: "Express delivery fee",
    help: "Per seller order, in paise (up to ₹1,00,000).",
  },
  {
    key: "delivery_fee_paise.ZAP",
    path: ["delivery_fee_paise", "ZAP"],
    kind: "paise",
    min: 0n,
    max: DELIVERY_FEE_CEILING_PAISE,
    default: 5_000_000n,
    label: "Zap delivery fee",
    help: "Per seller order, in paise (up to ₹1,00,000).",
  },
];

const BY_KEY: ReadonlyMap<string, ConfigKeySpec> = new Map(CONFIG_KEYS.map((k) => [k.key, k]));

/** The spec of an allow-listed key, or undefined. Own keys only: "__proto__" is never one. */
export function configKeySpec(key: string): ConfigKeySpec | undefined {
  return BY_KEY.get(key);
}

export interface ValidConfigValue {
  spec: ConfigKeySpec;
  value: bigint;
}

/**
 * Checks a proposed value: the key is allow-listed (CONFIG_KEY_UNKNOWN) and the value is a
 * canonical whole number (digits only, no sign, no leading zero) within the key's bounds
 * (CONFIG_VALUE_INVALID). The value arrives as a string: money is never a number (invariant 1).
 */
export function validateConfigValue(key: string, raw: string): ValidConfigValue {
  const spec = configKeySpec(key);
  if (spec === undefined) throw new DomainError("CONFIG_KEY_UNKNOWN", "that setting cannot be changed here");
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,14})$/.test(raw)) {
    throw new DomainError("CONFIG_VALUE_INVALID", "the value must be a whole number", { key });
  }
  const value = BigInt(raw);
  if (value < spec.min || value > spec.max) {
    throw new DomainError("CONFIG_VALUE_INVALID", `the value must be from ${spec.min} to ${spec.max}`, {
      key,
      min: spec.min.toString(),
      max: spec.max.toString(),
    });
  }
  return { spec, value };
}

/** How the value is written into a configuration version: money as a decimal string, a percent as a number. */
export function storedConfigValue(spec: ConfigKeySpec, value: bigint): string | number {
  return spec.kind === "paise" ? value.toString() : Number(value);
}

function at(values: unknown, path: readonly string[]): unknown {
  let cur: unknown = values;
  for (const part of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The value of a key in a configuration's `values`, read as core.config_paise / core.config_int
 * read it (migration 0016): a money value is a decimal string of 1 to 18 digits; a whole number is
 * a JSON integer or a digit string of up to 15; anything else is the default.
 */
export function readConfigValue(values: unknown, spec: ConfigKeySpec): bigint {
  const v = at(values, spec.path);
  if (spec.kind === "paise") {
    return typeof v === "string" && /^[0-9]{1,18}$/.test(v) ? BigInt(v) : spec.default;
  }
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < 1e15 ? BigInt(v) : spec.default;
  return typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? BigInt(v) : spec.default;
}

/** A value for people: "5%" or "₹1,200". */
export function describeConfigValue(spec: ConfigKeySpec, value: bigint): string {
  return spec.kind === "percent" ? `${value}%` : formatInrExact(value as Paise);
}

/**
 * The public announcement of an economy change (shown on the storefront). Names the setting and the
 * new value only: never the reason, the person or the old value.
 */
export function announcementText(key: string, newValue: string): string {
  const spec = configKeySpec(key);
  if (spec === undefined || !/^[0-9]{1,18}$/.test(newValue)) return "A store setting changed for new orders.";
  const shown = describeConfigValue(spec, BigInt(newValue));
  switch (spec.key) {
    case "fee_percent":
      return `The marketplace fee is now ${shown} on new orders.`;
    default:
      return `The ${spec.label.toLowerCase()} is now ${shown} on new orders.`;
  }
}

/** Whole seconds from `nowMs` to the ISO time, never below zero (0 for an unreadable time). */
export function secondsUntil(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** "24 h 0 min", "1 h 1 min", "under a minute" or "due now". */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "due now";
  if (seconds < 60) return "under a minute";
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
