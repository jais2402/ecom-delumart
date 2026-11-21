import "./server-only";
import pg from "pg";
import { SERVER_CONFIG } from "./config";
import { env } from "./env";

/**
 * The application pools, created on first use. The web pool logs in as app_web (read models,
 * the session check); the pay pool logs in as app_pay (money commands). Neither ever uses the
 * owner credential: that is held only by the dev sign-in provider and the scripts.
 */
let web: pg.Pool | undefined;
let pay: pg.Pool | undefined;
let jobs: pg.Pool | undefined;

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

/**
 * The jobs pool logs in as app_jobs (DATABASE_URL_JOBS): the screening job, the moderation safety
 * net and the purges. Null when the server has no jobs credential.
 */
export function jobsPool(): pg.Pool | null {
  const url = env().databaseUrlJobs;
  if (url === null) return null;
  jobs ??= createPool(url, SERVER_CONFIG.pools.jobsMax, "jobs");
  return jobs;
}

/** Ends every pool (tests, shutdown). The next call creates fresh ones. */
export async function closePools(): Promise<void> {
  const pools = [web, pay, jobs];
  web = undefined;
  pay = undefined;
  jobs = undefined;
  await Promise.all(pools.map((p) => p?.end()));
}
