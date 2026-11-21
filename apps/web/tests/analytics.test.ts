import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as funnel from "../src/app/api/v1/admin/analytics/funnel/route";
import * as overview from "../src/app/api/v1/admin/analytics/overview/route";
import * as places from "../src/app/api/v1/admin/analytics/places/route";
import * as timeseries from "../src/app/api/v1/admin/analytics/timeseries/route";
import * as top from "../src/app/api/v1/admin/analytics/top/route";
import * as adminReports from "../src/app/api/v1/admin/reports/route";
import * as events from "../src/app/api/v1/events/route";
import * as profile from "../src/app/api/v1/profile/route";
import { jobsPool } from "../src/server/db";
import { runJobs } from "../src/server/jobs";
import { startTestApp, type TestApp } from "./helpers/app";
import { Browser, type CallResult, str } from "./helpers/browser";
import { checkout, player, R } from "./helpers/flows";
import { makeAdmin } from "./helpers/studio";

/**
 * The analytics engine through the route handlers against a throwaway database (migration 0052):
 * POST /api/v1/events (validation, Origin, GPC/DNT, rate limit, no place or identity from the
 * body, the research opt-out), server events written on a real purchase, and the Super Admin
 * analytics reads (403 for anyone else, private, no-store, money as decimal strings).
 */
let app: TestApp;
let today: string;

const GEO = {
  "x-vercel-ip-country": "IN",
  "x-vercel-ip-country-region": "KA",
  "x-vercel-ip-city": "Bengaluru",
};

beforeAll(async () => {
  // the hosting edge's geo headers are read (as on Vercel)
  app = await startTestApp({ env: { GEO_SOURCE: "vercel" } });
  today = new Date().toISOString().slice(0, 10);
}, 180_000);

afterAll(async () => {
  await app.stop();
});

interface EventRow {
  name: string;
  surface: string;
  country: string;
  region: string | null;
  city: string | null;
  device_class: string;
  signed_in: boolean;
  props: Record<string, unknown>;
}

async function eventCount(): Promise<number> {
  return Number((await app.db.pool.query("SELECT count(*) AS n FROM analytics.event")).rows[0]?.n);
}

async function lastEvent(): Promise<EventRow | undefined> {
  const { rows } = await app.db.pool.query<EventRow>(
    "SELECT name, surface, country, region, city, device_class, signed_in, props FROM analytics.event ORDER BY id DESC LIMIT 1",
  );
  return rows[0];
}

function send(b: Browser, body: unknown, headers: Record<string, string> = {}, origin?: string | null) {
  return b.call(events.POST, "POST", "/api/v1/events", {
    body,
    headers: {
      ...GEO,
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile",
      ...headers,
    },
    csrf: false,
    ...(origin === undefined ? {} : { origin }),
  });
}

function expect204(res: CallResult) {
  expect(res.status).toBe(204);
  expect(res.text).toBe("");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

describe("POST /api/v1/events", () => {
  it("R16.5: records a page view with the edge's place and the device class only; always 204, private, no-store", async () => {
    const before = await eventCount();
    expect204(await send(new Browser(), { name: "page_view", surface: "shop" }));
    expect(await eventCount()).toBe(before + 1);
    expect(await lastEvent()).toEqual({
      name: "page_view",
      surface: "shop",
      country: "IN",
      region: "KA",
      city: "Bengaluru",
      device_class: "mobile",
      signed_in: false,
      props: {},
    });
  });

  it("R7.1: a place, identity or any unknown field in the body is refused: nothing recorded", async () => {
    const before = await eventCount();
    for (const body of [
      { name: "page_view", surface: "shop", country: "US" },
      { name: "page_view", surface: "shop", props: { city: "Austin" } },
      { name: "page_view", surface: "shop", userId: randomUUID() },
      { name: "search", surface: "shop", props: { resultCount: 3, queryLength: 4, query: "moon lamp" } },
      { name: "product_view", surface: "shop", props: { productId: "not-a-uuid" } },
      { name: "checkout_start", surface: "checkout", props: { itemCount: 1, totalPaise: "12.50" } },
      { name: "page_view", surface: "admin" },
      "not json at all",
    ]) {
      expect204(await send(new Browser(), body));
    }
    expect204(
      await new Browser().call(events.POST, "POST", "/api/v1/events", {
        rawBody: { text: "{bad json", contentType: "application/json" },
        csrf: false,
      }),
    );
    expect(await eventCount()).toBe(before);
  });

  it("server events (purchase, sign_up, creator_unlock, shop_registered, listing_published) are never accepted from a browser", async () => {
    const { b } = await player({ pin: false });
    const before = await eventCount();
    for (const name of ["purchase", "sign_up", "creator_unlock", "shop_registered", "listing_published"]) {
      expect204(await send(b, { name, surface: "checkout", props: {} }));
    }
    expect(await eventCount()).toBe(before);
  });

  it("a foreign or missing Origin records nothing", async () => {
    const before = await eventCount();
    expect204(await send(new Browser(), { name: "page_view", surface: "shop" }, {}, "https://evil.example"));
    expect204(await send(new Browser(), { name: "page_view", surface: "shop" }, {}, null));
    expect(await eventCount()).toBe(before);
  });

  it("Sec-GPC: 1 or DNT: 1 records nothing", async () => {
    const before = await eventCount();
    expect204(await send(new Browser(), { name: "page_view", surface: "shop" }, { "sec-gpc": "1" }));
    expect204(await send(new Browser(), { name: "page_view", surface: "shop" }, { dnt: "1" }));
    expect(await eventCount()).toBe(before);
  });

  it("search keeps only buckets; product views take category and company from the catalog", async () => {
    expect204(
      await send(new Browser(), {
        name: "search",
        surface: "shop",
        props: { resultCount: 0, queryLength: 9 },
      }),
    );
    expect((await lastEvent())?.props).toEqual({ result_count_bucket: "0", query_length_bucket: "4-10" });
    const p = app.products[0];
    if (!p) throw new Error("no product");
    expect204(
      await send(new Browser(), { name: "product_view", surface: "shop", props: { productId: p.id } }),
    );
    expect((await lastEvent())?.props).toEqual({ product_id: p.id, category: p.seed.category });
    expect204(
      await send(new Browser(), {
        name: "checkout_start",
        surface: "checkout",
        props: { itemCount: 2, totalPaise: "2500000" },
      }),
    );
    expect((await lastEvent())?.props).toEqual({ item_count: 2, amount_bucket: "10k_1l" });
  });

  it("R15.2: a signed-in player who switched on the research opt-out records nothing; signed-in players are marked", async () => {
    const { b } = await player({ pin: false });
    expect204(await send(b, { name: "page_view", surface: "account" }));
    expect((await lastEvent())?.signed_in).toBe(true);
    const opt = await b.call(profile.POST, "POST", "/api/v1/profile", { body: { researchOptOut: true } });
    expect(opt.status, opt.text).toBe(200);
    const before = await eventCount();
    expect204(await send(b, { name: "page_view", surface: "account" }));
    expect(await eventCount()).toBe(before);
  });

  it("is rate limited per address (120 a minute): beyond it events are dropped, still 204", async () => {
    const b = new Browser();
    const before = await eventCount();
    for (let i = 0; i < 122; i++) expect204(await send(b, { name: "page_view", surface: "shop" }));
    expect(await eventCount()).toBe(before + 120);
  });
});

describe("server events", () => {
  it("R16.5/invariant 5: a real purchase writes sign_up and purchase server-side (amount bucketed); a replay writes nothing more", async () => {
    const { b } = await player({ pin: false });
    const signUps = await app.db.pool.query(
      "SELECT count(*)::int AS n FROM analytics.event WHERE name = 'sign_up'",
    );
    expect(signUps.rows[0]?.n).toBeGreaterThan(0);
    const p = app.products[0];
    if (!p) throw new Error("no product");
    const session = await checkout(b, p.id);
    expect(session.status, session.text).toBe(201);
    const sessionId = str(session.json.id);
    const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "BALANCE" },
    });
    expect(attempt.status, attempt.text).toBe(201);
    const purchases = async () =>
      Number(
        (await app.db.pool.query("SELECT count(*) AS n FROM analytics.event WHERE name = 'purchase'")).rows[0]
          ?.n,
      );
    const before = await purchases();
    const key = randomUUID();
    const pay = () =>
      b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
        params: { id: sessionId },
        body: { attemptId: str(attempt.json.id) },
        idempotencyKey: key,
        headers: GEO,
      });
    const paid = await pay();
    expect(paid.status, paid.text).toBe(200);
    expect(await purchases()).toBe(before + 1);
    const { rows } = await app.db.pool.query<EventRow>(
      "SELECT name, surface, country, region, city, device_class, signed_in, props FROM analytics.event WHERE name = 'purchase' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0]).toMatchObject({ surface: "checkout", country: "IN", signed_in: true });
    expect(Object.keys(rows[0]?.props ?? {})).toEqual(["amount_bucket"]);
    expect(JSON.stringify(rows[0])).not.toContain(str(paid.json.totalPaise));
    expect((await pay()).status).toBe(200);
    expect(await purchases()).toBe(before + 1);
  });

  it("the jobs run rolls up yesterday and today and purges expired raw events", async () => {
    const pool = jobsPool();
    if (pool === null) throw new Error("no jobs pool");
    const report = await runJobs({ pool });
    expect(report.analyticsRollup?.todayEvents).toBeGreaterThan(0);
    expect(report.analyticsPurged).toBe(0);
    const rolled = await app.db.pool.query(
      "SELECT count(*)::int AS n FROM analytics.daily_rollup WHERE day = $1::date AND metric = 'visitors'",
      [today],
    );
    expect(rolled.rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/admin/analytics/*", () => {
  let admin: Browser;
  const q = (extra = "") => `from=${today}&to=${today}${extra}`;
  const routes = [
    { handler: overview.GET, path: () => `/api/v1/admin/analytics/overview?${q()}` },
    { handler: timeseries.GET, path: () => `/api/v1/admin/analytics/timeseries?${q("&metric=orders")}` },
    { handler: funnel.GET, path: () => `/api/v1/admin/analytics/funnel?${q()}` },
    { handler: places.GET, path: () => `/api/v1/admin/analytics/places?${q("&level=country")}` },
    { handler: top.GET, path: () => `/api/v1/admin/analytics/top?${q("&kind=product&limit=5")}` },
  ];

  it("US-56: anyone but the Super Admin gets the same 403 as on every admin route; anonymous 401", async () => {
    const someone = (await player({ pin: false })).b;
    const reports = await someone.call(adminReports.GET, "GET", "/api/v1/admin/reports");
    for (const r of routes) {
      const res = await someone.call(r.handler, "GET", r.path());
      expect(res.status, r.path()).toBe(403);
      expect(res.json).toEqual(reports.json);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect((await new Browser().call(r.handler, "GET", r.path())).status).toBe(401);
    }
  });

  it("R16.4: the Super Admin reads overview, timeseries, funnel, places and top; private, no-store; money as decimal strings", async () => {
    admin = (await player({ pin: false })).b;
    await makeAdmin(app, admin);
    // traffic rolled up for today
    const pool = jobsPool();
    if (pool !== null) await runJobs({ pool });
    const results: Record<string, CallResult> = {};
    for (const r of routes) {
      const res = await admin.call(r.handler, "GET", r.path());
      expect(res.status, `${r.path()} ${res.text}`).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      results[r.path().split("?")[0] ?? ""] = res;
    }
    const o = results["/api/v1/admin/analytics/overview"]?.json;
    expect(o).toMatchObject({
      from: today,
      to: today,
      days: 1,
      current: { orders: 1 },
      previous: { orders: 0 },
    });
    expect(typeof o?.current?.spendPaise).toBe("string");
    expect(o?.current?.spendPaise).toMatch(/^\d+$/);
    expect(o?.current?.averageOrderValuePaise).toBe(o?.current?.spendPaise);
    expect(o?.previous?.averageOrderValuePaise).toBeNull();
    expect(Number(o?.current?.visitors)).toBeGreaterThan(0);
    const t = results["/api/v1/admin/analytics/timeseries"]?.json;
    expect(t).toMatchObject({
      metric: "orders",
      unit: "count",
      source: "records",
      points: [{ day: today, value: "1" }],
    });
    const f = results["/api/v1/admin/analytics/funnel"]?.json;
    expect(f?.steps?.[0]).toMatchObject({ step: "visitors", conversionFromPrevious: null });
    const pl = results["/api/v1/admin/analytics/places"]?.json;
    expect(pl).toMatchObject({ level: "country", minVisitors: 10 });
    const tp = results["/api/v1/admin/analytics/top"]?.json;
    expect(tp?.items?.[0]).toMatchObject({ orders: 1, units: 1, shop: null });
    expect(tp?.items?.[0]?.spendPaise).toMatch(/^\d+$/);
    // aggregates only: no session, user or owner id anywhere
    const text = Object.values(results)
      .map((r) => r.text)
      .join();
    expect(text).not.toMatch(/userId|ownerId|sessionId|buyer/i);
  });

  it("date ranges are validated: from after to, longer than 366 days, malformed, unknown metric or kind", async () => {
    for (const path of [
      "/api/v1/admin/analytics/overview?from=2026-02-02&to=2026-02-01",
      "/api/v1/admin/analytics/overview?from=2024-01-01&to=2025-06-01",
      "/api/v1/admin/analytics/overview?from=2026-02-30&to=2026-03-01",
      "/api/v1/admin/analytics/overview?from=today&to=2026-03-01",
      `/api/v1/admin/analytics/timeseries?metric=revenue&${q()}`,
      `/api/v1/admin/analytics/top?kind=owner&${q()}`,
      `/api/v1/admin/analytics/top?kind=product&limit=500&${q()}`,
      `/api/v1/admin/analytics/places?level=street&${q()}`,
      `/api/v1/admin/analytics/overview?${q("&sql=1")}`,
    ]) {
      const handler =
        routes.find((r) => path.startsWith(r.path().split("?")[0] ?? "-"))?.handler ?? overview.GET;
      const res = await admin.call(handler, "GET", path);
      expect([400, 422], `${path} ${res.text}`).toContain(res.status);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
    }
  });
});
