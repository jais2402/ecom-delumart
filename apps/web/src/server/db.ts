import "./server-only";
import pg from "pg";
import { SERVER_CONFIG } from "./config";
import { env } from "./env";

/**
 * The two application pools, created on first use. The web pool logs in as app_web (read models,
 * the session check); the pay pool logs in as app_pay (money commands). Neither ever uses the
 * owner credential: that is held only by the dev sign-in provider and the scripts.
 */
let web: pg.Pool | undefined;
let pay: pg.Pool | undefined;

function createPool(connectionString: string, max: number, name: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: SERVER_CONFIG.pools.idleTimeoutMs,
    connectionTimeoutMillis: SERVER_CONFIG.pools.connectionTimeoutMs,
    application_name: `delulu-web-${name}`,
  });
  // An idle connection that dies must not crash the process; the message may carry server detail,
  // so only the SQLSTATE or errno code is logged.
  pool.on("error", (error: Error & { code?: string }) => {
    console.error(`[db:${name}] idle connection error`, error.code ?? error.name);
  });
  return pool;
}

export function webPool(): pg.Pool {
  web ??= createPool(env().databaseUrlWeb, SERVER_CONFIG.pools.webMax, "web");
  return web;
}

export function payPool(): pg.Pool {
  pay ??= createPool(env().databaseUrlPay, SERVER_CONFIG.pools.payMax, "pay");
  return pay;
}

/** Ends both pools (tests, shutdown). The next call creates fresh ones. */
export async function closePools(): Promise<void> {
  const pools = [web, pay];
  web = undefined;
  pay = undefined;
  await Promise.all(pools.map((p) => p?.end()));
}
