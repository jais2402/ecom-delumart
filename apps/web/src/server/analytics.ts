import "./server-only";
import { createHmac } from "node:crypto";
import {
  type AnalyticsEventName,
  deviceClassOf,
  type Place,
  parsePlace,
  SERVER_EVENT_NAMES,
  type Surface,
  UNKNOWN_COUNTRY,
} from "@delulu/core";
import { recordEvent, todaySalt } from "@delulu/db/runtime";
import { after } from "next/server";
import type pg from "pg";
import { clientAddress, placeAddressPrefix, rateAddressKey } from "./client-address";
import { SERVER_CONFIG } from "./config";
import { webPool } from "./db";
import { type Env, env } from "./env";

/**
 * Privacy-safe analytics capture (PRD R7.1, R15.2, R16.5; migration 0052).
 *
 *  - Keys are made under a day key, HMAC-SHA-256(ANALYTICS_KEY, the day's random salt), where the
 *    salt comes from the database (analytics.today_salt, 0061): only today's is ever handed out and
 *    the purge job deletes old ones, so an old day's keys can never be recomputed, even with
 *    ANALYTICS_KEY. The salt is cached in this process until the UTC day changes.
 *  - Browser events: the visitor key is HMAC(day key, "visitor | day | address (IPv6 by its /64) |
 *    user agent"), 16 bytes; the place key is HMAC(day key, "place | day | address prefix (IPv4
 *    /24, IPv6 /48)"), 8 bytes, which the database's place minimum counts (so one person with many
 *    user agents is still one). Neither the address nor the user agent is stored or logged.
 *  - Server events (purchase, sign_up, creator_unlock, shop_registered) carry neither key; the
 *    database stores them in their hour with no identifying prop.
 *  - The place is the hosting edge's approximate country, region and city, read only where the
 *    edge sets those headers (GEO_SOURCE), validated and capped (@delulu/core parsePlace); in
 *    development DEV_GEO may fix it. Nothing from a request body ever sets a place.
 *  - The device is a class (mobile, tablet, desktop, unknown), never the user agent.
 *  - Sec-GPC: 1 or DNT: 1 records nothing. The database records nothing for a signed-in account
 *    with the research opt-out or a test account.
 *  - Tracking never fails a request: any error is caught, counted and logged by code only.
 *    Routes schedule it with trackAfter, which runs after the response (Next's after()), so a
 *    response never waits for it.
 */

export type EventProps = Readonly<Record<string, string | number>>;

export interface TrackOptions {
  surface: Surface;
  /** The request's sign-in session id (passed to the database only), or null. */
  authSessionId: string | null;
  /** The clock, injectable for tests. */
  now?: () => Date;
  /** The app_web pool; defaults to the server's. */
  pool?: pg.Pool;
  /** Today's salt; defaults to the database's, cached per UTC day (injectable for tests). */
  salt?: (now: Date) => Promise<DailySalt>;
}

export interface DailySalt {
  /** The UTC day, YYYY-MM-DD, the salt belongs to. */
  day: string;
  salt: Buffer;
}

const VERCEL_COUNTRY = "x-vercel-ip-country";
const VERCEL_REGION = "x-vercel-ip-country-region";
const VERCEL_CITY = "x-vercel-ip-city";

let failures = 0;

/** How many tracking calls failed since the process started (for operations; no detail kept). */
export function analyticsFailures(): number {
  return failures;
}

/** The UTC day of a time, YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The day's key: both ANALYTICS_KEY and the day's random salt are needed to make any key. */
function dayKey(key: Buffer, salt: DailySalt): Buffer {
  return createHmac("sha256", key).update(salt.salt).update(`|${salt.day}`).digest();
}

/** The visitor key of a browser event (16 bytes), under the day's salt. */
export function visitorKey(key: Buffer, salt: DailySalt, address: string, userAgent: string): Buffer {
  const ua = userAgent.slice(0, SERVER_CONFIG.analytics.maxUserAgentChars);
  return createHmac("sha256", dayKey(key, salt))
    .update(`visitor|${salt.day}|${rateAddressKey(address)}|${ua}`)
    .digest()
    .subarray(0, SERVER_CONFIG.analytics.visitorKeyBytes);
}

/** The place key of a browser event (8 bytes): the address prefix only, under the day's salt. */
export function placeKey(key: Buffer, salt: DailySalt, address: string): Buffer {
  return createHmac("sha256", dayKey(key, salt))
    .update(`place|${salt.day}|${placeAddressPrefix(address)}`)
    .digest()
    .subarray(0, SERVER_CONFIG.analytics.placeKeyBytes);
}

let saltCache: DailySalt | null = null;

/**
 * Today's salt from the database, kept in this process until the UTC day of `now` changes (the
 * database hands out only its own today's salt).
 */
export async function dailySalt(
  now: Date,
  fetch: () => Promise<DailySalt> = () => todaySalt(webPool()),
): Promise<DailySalt> {
  const day = utcDay(now);
  if (saltCache !== null && saltCache.day === day) return saltCache;
  const fetched = await fetch();
  if (fetched.day === day) saltCache = fetched;
  return fetched;
}

/** Forgets the cached salt (tests). */
export function forgetDailySalt(): void {
  saltCache = null;
}

const SERVER_EVENTS: ReadonlySet<string> = new Set(SERVER_EVENT_NAMES);

/** The approximate place of a request, from where the configuration says it may come. */
export function placeOf(headers: Headers, config: Pick<Env, "geoSource" | "devGeo">): Place {
  if (config.devGeo !== null) return parsePlace(config.devGeo);
  if (config.geoSource !== "vercel") return { country: UNKNOWN_COUNTRY, region: null, city: null };
  return parsePlace({
    country: headers.get(VERCEL_COUNTRY),
    region: headers.get(VERCEL_REGION),
    city: headers.get(VERCEL_CITY),
  });
}

/** Global Privacy Control or Do Not Track: record nothing. */
export function declinesTracking(headers: Headers): boolean {
  return headers.get("sec-gpc")?.trim() === "1" || headers.get("dnt")?.trim() === "1";
}

const logFailure = (error: unknown) => {
  failures += 1;
  // a code only: messages can carry SQL or values, and nothing personal is ever logged here
  const code = (error as { code?: unknown } | null)?.code;
  console.error("[analytics] event not recorded", typeof code === "string" ? code : "");
};

/**
 * Records one event for this request. Returns whether it was stored; never throws. Server events
 * (purchase, sign_up, creator_unlock, shop_registered) are called by the server after the command
 * succeeded, with no visitor or place key; listing_published is recorded by the database itself.
 */
export async function track(
  request: Request,
  name: AnalyticsEventName,
  props: EventProps,
  options: TrackOptions,
): Promise<boolean> {
  try {
    const config = env();
    if (config.analyticsKey === null || declinesTracking(request.headers)) return false;
    const now = (options.now ?? (() => new Date()))();
    const place = placeOf(request.headers, config);
    const pool = options.pool ?? webPool();
    let keys: { visitorKey: Buffer | null; placeKey: Buffer | null } = { visitorKey: null, placeKey: null };
    if (!SERVER_EVENTS.has(name)) {
      const salt = await (options.salt ?? ((at: Date) => dailySalt(at, () => todaySalt(pool))))(now);
      const address = clientAddress(request, config.trustedProxyHops);
      keys = {
        visitorKey: visitorKey(config.analyticsKey, salt, address, request.headers.get("user-agent") ?? ""),
        placeKey: placeKey(config.analyticsKey, salt, address),
      };
    }
    return await recordEvent(pool, {
      authSessionId: options.authSessionId,
      name,
      surface: options.surface,
      ...keys,
      country: place.country,
      region: place.region,
      city: place.city,
      deviceClass: deviceClassOf(request.headers.get("user-agent")),
      props,
    });
  } catch (error) {
    logFailure(error);
    return false;
  }
}

const pending = new Set<Promise<boolean>>();

/**
 * Schedules `track` to run after the response has been sent (Next's after(); outside a request
 * scope, such as a test calling a handler directly, a background promise). The response never
 * waits for analytics, and tracking still never throws.
 */
export function trackAfter(
  request: Request,
  name: AnalyticsEventName,
  props: EventProps,
  options: TrackOptions,
): void {
  const run = () => {
    const p = track(request, name, props, options);
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Resolves when every scheduled tracking call so far has finished (tests). */
export async function settleTracking(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
