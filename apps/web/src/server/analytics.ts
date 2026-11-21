import "./server-only";
import { createHmac } from "node:crypto";
import {
  type AnalyticsEventName,
  deviceClassOf,
  type Place,
  parsePlace,
  type Surface,
  UNKNOWN_COUNTRY,
} from "@delulu/core";
import { recordEvent } from "@delulu/db/runtime";
import type pg from "pg";
import { clientAddress, rateAddressKey } from "./client-address";
import { SERVER_CONFIG } from "./config";
import { webPool } from "./db";
import { type Env, env } from "./env";

/**
 * Privacy-safe analytics capture (PRD R7.1, R15.2, R16.5; migration 0052).
 *
 *  - The visitor key is HMAC-SHA-256(ANALYTICS_KEY, "UTC day | address (IPv6 by its /64) | user
 *    agent"), truncated to 16 bytes. It changes every UTC day, and neither the address nor the user
 *    agent is stored or logged anywhere.
 *  - The place is the hosting edge's approximate country, region and city, read only where the
 *    edge sets those headers (GEO_SOURCE), validated and capped (@delulu/core parsePlace); in
 *    development DEV_GEO may fix it. Nothing from a request body ever sets a place.
 *  - The device is a class (mobile, tablet, desktop, unknown), never the user agent.
 *  - Sec-GPC: 1 or DNT: 1 records nothing. The database records nothing for a signed-in account
 *    with the research opt-out or a test account.
 *  - Tracking never fails a request: any error is caught, counted and logged by code only.
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

/** The daily-rotating visitor key (16 bytes). */
export function visitorKey(key: Buffer, day: string, address: string, userAgent: string): Buffer {
  const ua = userAgent.slice(0, SERVER_CONFIG.analytics.maxUserAgentChars);
  return createHmac("sha256", key)
    .update(`${day}|${rateAddressKey(address)}|${ua}`)
    .digest()
    .subarray(0, SERVER_CONFIG.analytics.visitorKeyBytes);
}

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
 * succeeded; listing_published is recorded by the database itself.
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
    return await recordEvent(options.pool ?? webPool(), {
      authSessionId: options.authSessionId,
      name,
      surface: options.surface,
      visitorKey: visitorKey(
        config.analyticsKey,
        utcDay(now),
        clientAddress(request, config.trustedProxyHops),
        request.headers.get("user-agent") ?? "",
      ),
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
