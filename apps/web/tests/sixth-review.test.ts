import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as jobsRoute from "../src/app/api/internal/jobs/run/route";
import * as adminReports from "../src/app/api/v1/admin/reports/route";
import * as adminStatus from "../src/app/api/v1/admin/status/route";
import { JOBS_SIGNATURE_HEADER, JOBS_TIMESTAMP_HEADER, signJobsRequest } from "../src/server/jobs-signature";
import { APP_ORIGIN, startTestApp, type TestApp } from "./helpers/app";
import { Browser, type CallResult, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";
import { makeAdmin } from "./helpers/studio";

/**
 * Sixth security review, through the route handlers against a throwaway database: the console
 * status route (major 4), the jobs endpoint's replay guard (minor 9) and per-/64 IPv6 rate limits
 * (minor 10). The limits are asserted at their production values.
 */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
}, 180_000);

afterAll(async () => {
  await app.stop();
});

async function signedJobs(timestamp: string, body = "{}"): Promise<CallResult> {
  const key = Buffer.from(process.env.JOBS_SIGNING_KEY ?? "", "hex");
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(JOBS_TIMESTAMP_HEADER, timestamp);
  headers.set(JOBS_SIGNATURE_HEADER, signJobsRequest(key, timestamp, body));
  const res = await jobsRoute.POST(
    new Request(new URL("/api/internal/jobs/run", APP_ORIGIN), { method: "POST", headers, body }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : {} };
}

describe("major 4: GET /api/v1/admin/status", () => {
  it("US-38: the Super Admin reads the publication switch, overdue reviews, open cases and appeals; private, no-store", async () => {
    const admin = (await player({ pin: false })).b;
    await makeAdmin(app, admin);
    const res = await admin.call(adminStatus.GET, "GET", "/api/v1/admin/status");
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.json).toMatchObject({
      publication: { enabled: true },
      moderationOverdue: { count: 0, thresholdHours: 48 },
      openReportCases: expect.any(Number),
      openAppeals: expect.any(Number),
      needsReview: expect.any(Number),
    });
  });

  it("US-38: anyone else gets the same 403 as on every admin route", async () => {
    const someone = (await player({ pin: false })).b;
    const status = await someone.call(adminStatus.GET, "GET", "/api/v1/admin/status");
    const reports = await someone.call(adminReports.GET, "GET", "/api/v1/admin/reports");
    expect(status.status).toBe(403);
    expect(status.json).toEqual(reports.json);
    const anonymous = new Browser();
    expect((await anonymous.call(adminStatus.GET, "GET", "/api/v1/admin/status")).status).toBe(401);
  });
});

describe("minor 9: the jobs endpoint accepts a signed request once", () => {
  it("a replay within the 60-second window is refused like a bad signature, and runs nothing", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 5);
    const first = await signedJobs(timestamp);
    expect(first.status, first.text).toBe(200);
    const before = await app.db.pool.query("SELECT count(*)::int AS n FROM audit.audit_log");
    const replay = await signedJobs(timestamp);
    expect(replay.status).toBe(403);
    expect(replay.json.error?.code).toBe("FORBIDDEN");
    expect((await app.db.pool.query("SELECT count(*)::int AS n FROM audit.audit_log")).rows).toEqual(
      before.rows,
    );
    // only a digest of the signature is kept
    const { rows } = await app.db.pool.query<{ h: Buffer }>(
      "SELECT signature_hash AS h FROM core.jobs_request_seen",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.h.length).toBe(32);
  });

  it("fails closed: when the replay guard cannot be reached nothing runs", async () => {
    await app.db.pool.query(
      "REVOKE EXECUTE ON FUNCTION core.jobs_accept_request(bytea, timestamptz) FROM app_jobs",
    );
    try {
      const res = await signedJobs(String(Math.floor(Date.now() / 1000) - 3));
      expect(res.status).toBe(503);
      expect(res.json.report).toBeUndefined();
    } finally {
      await app.db.pool.query(
        "GRANT EXECUTE ON FUNCTION core.jobs_accept_request(bytea, timestamptz) TO app_jobs",
      );
    }
  });
});

describe("minor 10: IPv6 clients are limited by their /64", () => {
  it("US-01: sign-in attempts from many addresses of one /64 share one budget (20 / minute); another /64 has its own", async () => {
    const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:77`;
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const b = new Browser();
      b.peer = `${prefix}::${(i + 1).toString(16)}`;
      b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
      const res = await b.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
        body: { email: "not-an-email" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    const other = new Browser();
    other.peer = `${prefix.slice(0, -2)}78::1`;
    other.csrfToken = str((await other.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    const res = await other.call(R.devSignIn.POST, "POST", "/api/v1/auth/dev/sign-in", {
      body: { email: "not-an-email" },
    });
    expect(res.status).toBe(422);
  });
});
