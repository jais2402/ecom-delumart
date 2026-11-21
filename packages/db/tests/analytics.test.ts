import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyticsFunnel,
  analyticsOverview,
  analyticsPlaces,
  analyticsTimeseries,
  analyticsTop,
  type RecordEventInput,
  recordEvent,
} from "../src/analytics";
import { purgeAnalyticsEvents, rollupAnalytics } from "../src/jobs";
import { checkout, codeOf, payFor, RUPEE, standard, user } from "./checkout-fixtures";
import { createTestDatabase, stateOf, type TestDatabase, type TestUser } from "./helpers";
import { CATEGORY, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

/**
 * Migration 0052: the analytics engine. Privacy-safe capture (no identity, address, user agent,
 * search text or amount; an allow-list of props per event), append-only storage with a retention
 * purge, idempotent daily rollups with small-count suppression of place (PRD R7.1), and the Super
 * Admin's reads, which check the Super Admin in the database and read money from the real tables.
 */
const APP_ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro", "anon", "authenticated"];
const NEW_TABLES = ["analytics.event", "analytics.daily_rollup", "analytics.rollup_run"];

let db: TestDatabase;
let pool: pg.Pool;
let admin: TestUser;
let buyer: TestUser;
let today: string;

/** A day `offset` days from today (UTC), as YYYY-MM-DD. */
const dayAt = (offset: number): string => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/** A stable 16-byte visitor key for a test label (stands for the web server's keyed hash). */
const vk = (label: string): Buffer => createHash("sha256").update(label).digest().subarray(0, 16);

interface PlantedEvent {
  day: string;
  name: string;
  visitor: string;
  country?: string;
  region?: string | null;
  city?: string | null;
  props?: Record<string, unknown>;
  surface?: string;
  device?: string;
}

/** Writes past-dated events as the owner (the capture path only ever writes the present minute). */
async function plantEvents(events: readonly PlantedEvent[]): Promise<void> {
  for (const [i, e] of events.entries()) {
    await pool.query(
      `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                    device_class, props)
       VALUES (($1::date)::timestamp AT TIME ZONE 'UTC' + make_interval(mins => $2), $1::date, $3, $4, $5, false,
               $6, $7, $8, $9, $10::jsonb)`,
      [
        e.day,
        i % 1400,
        e.name,
        e.surface ?? "shop",
        vk(e.visitor),
        e.country ?? "IN",
        e.region === undefined ? "MH" : e.region,
        e.city === undefined ? "Mumbai" : e.city,
        e.device ?? "mobile",
        JSON.stringify(e.props ?? {}),
      ],
    );
  }
}

function event(overrides: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    authSessionId: null,
    name: "page_view",
    surface: "shop",
    visitorKey: randomBytes(16),
    country: "IN",
    region: "KA",
    city: "Bengaluru",
    deviceClass: "desktop",
    props: {},
    ...overrides,
  };
}

async function rollup(day: string): Promise<void> {
  await pool.query("SELECT analytics.rollup_day($1::date)", [day]);
}

async function rollupRows(day: string, kind: string, metric = "visitors") {
  const { rows } = await pool.query<{ value: string; count: string; visitors: string }>(
    `SELECT dimension_value AS value, count::text, visitors::text FROM analytics.daily_rollup
      WHERE day = $1 AND dimension_kind = $2 AND metric = $3 ORDER BY dimension_value`,
    [day, kind, metric],
  );
  return rows.map((r) => ({ value: r.value, count: Number(r.count), visitors: Number(r.visitors) }));
}

const range = (from: string, to: string = from) => ({ authSessionId: admin.authSessionId, from, to });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  today = (await pool.query<{ d: string }>("SELECT analytics.utc_today()::text AS d")).rows[0]?.d ?? "";
  admin = await user(pool);
  await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  buyer = await user(pool);
}, 120_000);

afterAll(async () => {
  await db.drop();
});

// ------------------------------------------------------------------ schema and privileges

describe("0052: the event table holds nothing personal", () => {
  it("R7.1/R16.5: analytics.event has exactly the privacy-safe columns: no user, session, address, agent, contact, text or amount", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'analytics' AND table_name = 'event' ORDER BY ordinal_position`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual([
      "id",
      "occurred_at",
      "day",
      "name",
      "surface",
      "visitor_key",
      "signed_in",
      "country",
      "region",
      "city",
      "device_class",
      "props",
    ]);
    for (const c of columns) {
      expect(c).not.toMatch(
        /user|session|ip|addr|agent|ua|email|phone|query|search|text|amount|paise|birth|pin|card/,
      );
    }
    for (const table of ["daily_rollup", "rollup_run"]) {
      const { rows: cols } = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = $1",
        [table],
      );
      for (const c of cols) expect(c.column_name).not.toMatch(/user|session|ip|addr|agent|email|phone|key/);
    }
  });

  it("no application role (research_ro and npc_worker included) holds any privilege on the new tables; RLS is on", async () => {
    const { rows } = await pool.query<{ r: string; t: string; p: string }>(
      `SELECT r, t, p FROM unnest($1::text[]) r, unnest($2::text[]) t,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE CASE WHEN p IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege(r, t, p)
                   ELSE has_table_privilege(r, t, p) END`,
      [APP_ROLES, NEW_TABLES],
    );
    expect(rows).toEqual([]);
    const seq = await pool.query<{ r: string }>(
      `SELECT r FROM unnest($1::text[]) r
        WHERE has_sequence_privilege(r, 'analytics.event_id_seq', 'USAGE')
           OR has_sequence_privilege(r, 'analytics.event_id_seq', 'UPDATE')`,
      [APP_ROLES],
    );
    expect(seq.rows).toEqual([]);
    const rls = await pool.query<{ t: string; on: boolean }>(
      `SELECT c.oid::regclass::text AS t, c.relrowsecurity AS on FROM pg_class c
        WHERE c.oid = ANY ($1::regclass[]) ORDER BY 1`,
      [NEW_TABLES],
    );
    expect(rls.rows.every((r) => r.on)).toBe(true);
    expect(rls.rows).toHaveLength(3);
    for (const role of ["app_web", "app_jobs", "research_ro", "npc_worker"]) {
      expect(await stateOf(pool, "SELECT 1 FROM analytics.event", [], { role }), role).toBe("42501");
      expect(await stateOf(pool, "SELECT 1 FROM analytics.daily_rollup", [], { role }), role).toBe("42501");
    }
  });

  it("each analytics function is executable by exactly the roles that need it; every definer pins its search_path", async () => {
    const { rows } = await pool.query<{
      f: string;
      roles: string[] | null;
      definer: boolean;
      pinned: boolean;
    }>(
      `SELECT p.oid::regprocedure::text AS f, p.prosecdef AS definer,
              EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=pg_catalog, pg_temp') AS pinned,
              (SELECT array_agg(r ORDER BY r) FROM unnest($1::text[]) r
                WHERE has_function_privilege(r, p.oid, 'EXECUTE')) AS roles
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'analytics' OR p.proname LIKE 'analytics\\_%'
        ORDER BY 1`,
      [APP_ROLES],
    );
    const granted = Object.fromEntries(rows.filter((r) => r.roles !== null).map((r) => [r.f, r.roles]));
    expect(granted).toEqual({
      "analytics.admin_funnel(date,date)": ["app_web"],
      "analytics.admin_overview(date,date)": ["app_web"],
      "analytics.admin_places(text,text,text,date,date)": ["app_web"],
      "analytics.admin_timeseries(text,date,date)": ["app_web"],
      "analytics.admin_top(text,date,date,integer)": ["app_web"],
      "analytics.record_event(text,text,bytea,text,text,text,text,jsonb)": ["app_web"],
      "core.analytics_purge_job()": ["app_jobs"],
      "core.analytics_rollup_job()": ["app_jobs"],
    });
    expect(rows.find((r) => r.f === "analytics.dev_seed_synthetic_events(integer)")?.roles).toBeNull();
    expect(rows.find((r) => r.f === "analytics.rollup_day(date)")?.roles).toBeNull();
    for (const r of rows.filter((x) => x.definer)) expect(r.pinned, r.f).toBe(true);
    // app_jobs still has no USAGE on the analytics schema (0047)
    const usage = await pool.query<{ ok: boolean }>(
      "SELECT has_schema_privilege('app_jobs', 'analytics', 'USAGE') AS ok",
    );
    expect(usage.rows[0]?.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ capture

describe("0052: analytics.record_event (app_web)", () => {
  it("R7.1: stores the minute, the UTC day, the place labels and whether the request was signed in — nothing else", async () => {
    const key = randomBytes(16);
    expect(await recordEvent(pool, event({ visitorKey: key }))).toBe(true);
    expect(await recordEvent(pool, event({ visitorKey: key, authSessionId: buyer.authSessionId }))).toBe(
      true,
    );
    const { rows } = await pool.query<{
      signed_in: boolean;
      minute_ok: boolean;
      day_ok: boolean;
      region: string;
    }>(
      `SELECT signed_in, extract(second FROM occurred_at) = 0 AS minute_ok,
              day = (occurred_at AT TIME ZONE 'UTC')::date AS day_ok, region
         FROM analytics.event WHERE visitor_key = $1 ORDER BY id`,
      [key],
    );
    expect(rows).toEqual([
      { signed_in: false, minute_ok: true, day_ok: true, region: "KA" },
      { signed_in: true, minute_ok: true, day_ok: true, region: "KA" },
    ]);
  });

  it("props outside the allow-list (unknown keys, oversized or wrongly typed values) are refused", async () => {
    const refused: [string, Record<string, string | number>][] = [
      ["page_view", { path: "/p/1" }],
      ["search", { query: "moon lamp" }],
      ["search", { result_count_bucket: "17" }],
      ["search", { query_length_bucket: "4-10", email: "a@b.c" }],
      ["product_view", { product_id: "not-a-uuid" }],
      ["checkout_start", { item_count: 101 }],
      ["checkout_start", { item_count: "2" }],
      ["checkout_start", { amount_bucket: "123456" }],
      ["checkout_start", { amount_paise: "123456" }],
      ["search", { category: "x".repeat(41) }],
      [
        "search",
        { category: "a".repeat(40), result_count_bucket: "0", query_length_bucket: "0", x: "y".repeat(300) },
      ],
    ];
    for (const [name, props] of refused) {
      expect(await codeOf(recordEvent(pool, event({ name, props }))), JSON.stringify(props)).toBe(
        "VALIDATION_FAILED",
      );
    }
    // and the table refuses them whoever writes (the owner here)
    expect(
      await stateOf(
        pool,
        `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, device_class, props)
         VALUES (date_trunc('minute', now()), (date_trunc('minute', now()) AT TIME ZONE 'UTC')::date, 'search', 'shop',
                 $1, false, 'IN', 'mobile', '{"query": "moon lamp"}')`,
        [randomBytes(16)],
      ),
    ).toBe("23514");
  });

  it("R7.1: search events keep only the result-count and query-length buckets", async () => {
    const key = randomBytes(16);
    expect(
      await recordEvent(
        pool,
        event({
          name: "search",
          visitorKey: key,
          props: { result_count_bucket: "0", query_length_bucket: "4-10" },
        }),
      ),
    ).toBe(true);
    const { rows } = await pool.query<{ props: unknown }>(
      "SELECT props FROM analytics.event WHERE visitor_key = $1",
      [key],
    );
    expect(rows).toEqual([{ props: { result_count_bucket: "0", query_length_bucket: "4-10" } }]);
  });

  it("invalid names, surfaces, places, devices and keys are refused", async () => {
    for (const bad of [
      { name: "order_paid" },
      { surface: "admin" },
      { country: "India" },
      { country: "ZZ" }, // an unknown country carries no region or city
      { region: "MH|Mumbai" },
      { city: "<b>Pune</b>" },
      { city: "x".repeat(65) },
      { deviceClass: "iphone" },
      { visitorKey: randomBytes(32) },
    ] satisfies Partial<RecordEventInput>[]) {
      expect(await codeOf(recordEvent(pool, event(bad))), JSON.stringify(bad)).toBe("VALIDATION_FAILED");
    }
    expect(await recordEvent(pool, event({ country: "ZZ", region: null, city: null }))).toBe(true);
  });

  it("server events need a signed-in actor; listing_published is never accepted from app_web; a shop must be the actor's", async () => {
    for (const name of ["purchase", "sign_up", "creator_unlock", "shop_registered"]) {
      expect(await codeOf(recordEvent(pool, event({ name, surface: "checkout" }))), name).toBe(
        "VALIDATION_FAILED",
      );
    }
    expect(
      await codeOf(
        recordEvent(pool, event({ name: "listing_published", authSessionId: buyer.authSessionId })),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      await recordEvent(
        pool,
        event({
          name: "purchase",
          surface: "checkout",
          authSessionId: buyer.authSessionId,
          props: { item_count: 2, amount_bucket: "10k_1l" },
        }),
      ),
    ).toBe(true);
    const someone = await user(pool);
    const companyId = (
      await pool.query<{ id: string }>(
        "INSERT INTO core.company (id, owner_user_id, name) VALUES (gen_random_uuid(), $1, 'Other Shop') RETURNING id",
        [someone.userId],
      )
    ).rows[0]?.id;
    expect(
      await codeOf(
        recordEvent(
          pool,
          event({
            name: "shop_registered",
            surface: "studio",
            authSessionId: buyer.authSessionId,
            props: { company_id: companyId ?? "" },
          }),
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("R15.2: a signed-in account with the research opt-out records nothing; so does a test (STAFF) account", async () => {
    const opted = await user(pool);
    await pool.query("UPDATE core.user_profile SET research_opt_out = true WHERE id = $1", [opted.userId]);
    const tester = await user(pool);
    await pool.query("UPDATE core.user_profile SET is_test_account = true WHERE id = $1", [tester.userId]);
    const before = Number((await pool.query("SELECT count(*) AS n FROM analytics.event")).rows[0]?.n);
    for (const u of [opted, tester]) {
      expect(await recordEvent(pool, event({ authSessionId: u.authSessionId }))).toBe(false);
      expect(
        await recordEvent(
          pool,
          event({ authSessionId: u.authSessionId, name: "sign_up", surface: "account" }),
        ),
      ).toBe(false);
    }
    expect(Number((await pool.query("SELECT count(*) AS n FROM analytics.event")).rows[0]?.n)).toBe(before);
  });

  it("product_view and cart_add: the category and company come from the catalog; an unpublished or unknown product records nothing", async () => {
    const [p] = await published(pool, 1);
    const key = randomBytes(16);
    expect(
      await recordEvent(
        pool,
        event({
          name: "product_view",
          visitorKey: key,
          props: { product_id: p?.id ?? "", category: "made-up" },
        }),
      ),
    ).toBe(true);
    const { rows } = await pool.query<{ props: unknown }>(
      "SELECT props FROM analytics.event WHERE visitor_key = $1",
      [key],
    );
    expect(rows).toEqual([{ props: { product_id: p?.id, category: "gadgets" } }]);
    expect(
      await recordEvent(
        pool,
        event({ name: "cart_add", props: { product_id: "00000000-0000-0000-0000-000000000000" } }),
      ),
    ).toBe(false);
    await pool.query("UPDATE core.product SET status = 'HIDDEN' WHERE id = $1", [p?.id]);
    expect(await recordEvent(pool, event({ name: "cart_add", props: { product_id: p?.id ?? "" } }))).toBe(
      false,
    );
  });

  it("append-only: no UPDATE, DELETE or TRUNCATE, even as the owner; only the retention purge deletes", async () => {
    expect(await stateOf(pool, "UPDATE analytics.event SET country = 'US'")).toBe("DM001");
    expect(await stateOf(pool, "DELETE FROM analytics.event")).toBe("DM001");
    expect(await stateOf(pool, "TRUNCATE analytics.event")).toBe("DM001");
    for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      expect(
        await stateOf(
          pool,
          "SELECT analytics.record_event(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
          [],
          {
            role,
          },
        ),
        role,
      ).toBe(role === "app_web" ? "DM001" : "42501");
    }
  });
});

// ------------------------------------------------------------------ rollups

describe("0052: analytics.rollup_day", () => {
  it("R16.5: is idempotent: re-running a day replaces its rows; a late event is counted on the next run", async () => {
    const day = dayAt(-5);
    await plantEvents([
      { day, name: "page_view", visitor: "r1" },
      { day, name: "page_view", visitor: "r1" },
      { day, name: "page_view", visitor: "r2", device: "desktop" },
      {
        day,
        name: "product_view",
        visitor: "r2",
        props: { product_id: "11111111-1111-4111-8111-111111111111", category: "gadgets" },
      },
    ]);
    await rollup(day);
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT metric, dimension_kind, dimension_value, count, visitors FROM analytics.daily_rollup
            WHERE day = $1 ORDER BY 1, 2, 3`,
          [day],
        )
      ).rows;
    const first = await snapshot();
    await rollup(day);
    await rollup(day);
    expect(await snapshot()).toEqual(first);
    const none = (metric: string) =>
      rollupRows(day, "none", metric).then((r) => ({ count: r[0]?.count, visitors: r[0]?.visitors }));
    expect(await none("page_views")).toEqual({ count: 3, visitors: 2 });
    expect(await none("visitors")).toEqual({ count: 2, visitors: 2 });
    expect(await rollupRows(day, "category", "product_views")).toEqual([
      { value: "gadgets", count: 1, visitors: 1 },
    ]);
    expect(await rollupRows(day, "device_class", "page_views")).toEqual([
      { value: "desktop", count: 1, visitors: 1 },
      { value: "mobile", count: 2, visitors: 1 },
    ]);
    // a late event of that day
    await plantEvents([{ day, name: "page_view", visitor: "r3" }]);
    await rollup(day);
    expect(await none("page_views")).toEqual({ count: 4, visitors: 3 });
    const run = await pool.query(
      "SELECT events::int, min_visitors FROM analytics.rollup_run WHERE day = $1",
      [day],
    );
    expect(run.rows).toEqual([{ events: 5, min_visitors: 10 }]);
  });

  it("R7.1: a city, region or country below the minimum (10 distinct visitors a day) is folded upward before it is stored", async () => {
    const day = dayAt(-6);
    const events: PlantedEvent[] = [];
    for (let i = 0; i < 12; i++) events.push({ day, name: "page_view", visitor: `mum${i}`, city: "Mumbai" });
    for (let i = 0; i < 3; i++) events.push({ day, name: "page_view", visitor: `lon${i}`, city: "Lonavala" });
    for (let i = 0; i < 2; i++)
      events.push({ day, name: "page_view", visitor: `kaz${i}`, region: "HP", city: "Kaza" });
    events.push({ day, name: "sign_up", visitor: "kaz0", region: "HP", city: "Kaza", surface: "account" });
    events.push({ day, name: "page_view", visitor: "fr0", country: "FR", region: "IDF", city: "Paris" });
    await plantEvents(events);
    await rollup(day);
    expect(await rollupRows(day, "country")).toEqual([
      { value: "IN", count: 17, visitors: 17 },
      { value: "Other", count: 1, visitors: 1 },
    ]);
    expect(await rollupRows(day, "region")).toEqual([
      { value: "IN|MH", count: 15, visitors: 15 },
      { value: "IN|Other", count: 2, visitors: 2 },
      { value: "Other|Other", count: 1, visitors: 1 },
    ]);
    expect(await rollupRows(day, "city")).toEqual([
      { value: "IN|MH|Mumbai", count: 12, visitors: 12 },
      { value: "IN|MH|Other", count: 3, visitors: 3 },
      { value: "IN|Other|Other", count: 2, visitors: 2 },
      { value: "Other|Other|Other", count: 1, visitors: 1 },
    ]);
    expect(await rollupRows(day, "city", "sign_ups")).toEqual([
      { value: "IN|Other|Other", count: 1, visitors: 1 },
    ]);
    const named = await pool.query(
      `SELECT 1 FROM analytics.daily_rollup WHERE day = $1
          AND (dimension_value ~ 'Lonavala|Kaza|Paris|HP|FR|IDF')`,
      [day],
    );
    expect(named.rows).toEqual([]);
  });

  it("R7.1: the minimum comes from the configuration", async () => {
    const day = dayAt(-6);
    await pool.query(
      `INSERT INTO core.config_version (values, effective_from, note)
       SELECT values || '{"analytics": {"place_min_visitors": 3}}', now() - interval '1 second', 'test: min 3'
         FROM core.config_version WHERE id = 1`,
    );
    try {
      await rollup(day);
      expect((await rollupRows(day, "city")).map((r) => r.value)).toEqual([
        "IN|MH|Lonavala",
        "IN|MH|Mumbai",
        "IN|Other|Other",
        "Other|Other|Other",
      ]);
    } finally {
      await pool.query(
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT values, now() - interval '1 second', 'test: restore' FROM core.config_version WHERE id = 1`,
      );
      await rollup(day);
    }
    expect((await rollupRows(day, "city")).map((r) => r.value)).not.toContain("IN|MH|Lonavala");
  });

  it("raw events are purged after the retention (90 days by default); rollups are kept; a purged day is never re-rolled", async () => {
    const old = dayAt(-91);
    const recent = dayAt(-10);
    await plantEvents([
      { day: old, name: "page_view", visitor: "old" },
      { day: recent, name: "page_view", visitor: "recent" },
    ]);
    await pool.query(
      `INSERT INTO analytics.daily_rollup (day, metric, dimension_kind, dimension_value, count, visitors, computed_at)
       VALUES ($1, 'page_views', 'none', '', 1, 1, now())`,
      [old],
    );
    expect(await codeOf(pool.query("SELECT analytics.rollup_day($1::date)", [old]))).toBe("DM001");
    expect(await purgeAnalyticsEvents(pool)).toBe(1);
    const left = await pool.query<{ day: string }>(
      "SELECT day::text FROM analytics.event WHERE day IN ($1::date, $2::date) ORDER BY day",
      [old, recent],
    );
    expect(left.rows).toEqual([{ day: recent }]);
    expect((await rollupRows(old, "none", "page_views")).length).toBe(1);
    expect(await purgeAnalyticsEvents(pool)).toBe(0);
  });

  it("the jobs roll up yesterday and today as app_jobs, through core functions only", async () => {
    const result = await rollupAnalytics(pool);
    expect(result.yesterday.day).toBe(dayAt(-1));
    expect(result.today.day).toBe(today);
    expect(result.today.events).toBeGreaterThan(0);
    expect(await stateOf(pool, "SELECT analytics.rollup_day(CURRENT_DATE)", [], { role: "app_jobs" })).toBe(
      "42501",
    );
    expect(await stateOf(pool, "SELECT analytics.purge_events()", [], { role: "app_jobs" })).toBe("42501");
    expect(await stateOf(pool, "SELECT core.analytics_rollup_job()", [], { role: "app_web" })).toBe("42501");
  });
});

// ------------------------------------------------------------------ Super Admin reads

describe("0052: the Super Admin's reads", () => {
  const calls = (session: string) => {
    const r = { authSessionId: session, from: today, to: today };
    return [
      () => analyticsOverview(pool, r),
      () => analyticsTimeseries(pool, { ...r, metric: "orders" }),
      () => analyticsFunnel(pool, r),
      () => analyticsPlaces(pool, { ...r, level: "country", country: null, region: null }),
      () => analyticsTop(pool, { ...r, kind: "product", limit: 10 }),
    ];
  };

  it("R16.7/US-56: every read refuses anyone but the Super Admin in the database itself", async () => {
    for (const call of calls(buyer.authSessionId)) expect(await codeOf(call())).toBe("FORBIDDEN");
    for (const sql of [
      "SELECT analytics.admin_overview(CURRENT_DATE, CURRENT_DATE)",
      "SELECT analytics.admin_timeseries('orders', CURRENT_DATE, CURRENT_DATE)",
      "SELECT analytics.admin_funnel(CURRENT_DATE, CURRENT_DATE)",
      "SELECT analytics.admin_places('country', NULL, NULL, CURRENT_DATE, CURRENT_DATE)",
      "SELECT analytics.admin_top('product', CURRENT_DATE, CURRENT_DATE, 10)",
    ]) {
      expect(await stateOf(pool, sql, [], { role: "app_web" }), sql).toBe("DM001"); // no session: FORBIDDEN
      expect(await stateOf(pool, sql, [], { role: "app_web", userId: buyer.userId }), sql).toBe("DM001");
      for (const role of ["app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        expect(await stateOf(pool, sql, [], { role }), `${role} ${sql}`).toBe("42501");
      }
    }
    for (const call of calls(admin.authSessionId)) expect(await codeOf(call())).toBe("ok");
  });

  it("date ranges: from after to, or longer than 366 days, are refused", async () => {
    expect(await codeOf(analyticsOverview(pool, range(today, dayAt(-1))))).toBe("VALIDATION_FAILED");
    expect(await codeOf(analyticsFunnel(pool, range(dayAt(-366), today)))).toBe("VALIDATION_FAILED");
    expect(await codeOf(analyticsFunnel(pool, range(dayAt(-365), today)))).toBe("ok");
    expect(await codeOf(analyticsTop(pool, { ...range(today), kind: "product", limit: 51 }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(await codeOf(analyticsTimeseries(pool, { ...range(today), metric: "revenue" as "orders" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("invariant 5/US-58: orders, spend and sign-ups come from the real tables and the ledger; a forged purchase event changes nothing", async () => {
    const [p] = await published(pool, 1, 250n * RUPEE);
    if (!p) throw new Error("no product");
    const shopper = await user(pool);
    await payFor(pool, shopper, await checkout(pool, shopper, [p], standard("SEED")));
    const before = await analyticsOverview(pool, range(today));
    // a forged purchase event (as a signed-in web call could make)
    await recordEvent(
      pool,
      event({
        name: "purchase",
        surface: "checkout",
        authSessionId: shopper.authSessionId,
        props: { item_count: 9 },
      }),
    );
    const o = await analyticsOverview(pool, range(today));
    expect(o.current.orders).toBe(before.current.orders);
    expect(o.current.spendPaise).toBe(before.current.spendPaise);
    const truth = await pool.query<{ n: string; s: string; u: string }>(
      `SELECT (SELECT count(*) FROM core.order_group WHERE buyer_source = 'PLAYER'
                 AND created_at >= $1::date AND created_at < $1::date + 1)::text AS n,
              (SELECT COALESCE(sum(total_paise), 0) FROM core.order_group WHERE buyer_source = 'PLAYER'
                 AND created_at >= $1::date AND created_at < $1::date + 1)::text AS s,
              (SELECT count(*) FROM core.user_profile WHERE role = 'PLAYER' AND NOT is_test_account
                 AND provisioned_at >= $1::date AND provisioned_at < $1::date + 1)::text AS u`,
      [today],
    );
    expect(o.current.orders).toBe(Number(truth.rows[0]?.n));
    expect(o.current.orders).toBeGreaterThan(0);
    expect(o.current.spendPaise).toBe(BigInt(truth.rows[0]?.s ?? "-1"));
    expect(o.current.averageOrderValuePaise).toBe(o.current.spendPaise / BigInt(o.current.orders));
    expect(o.current.signUps).toBe(Number(truth.rows[0]?.u));
    expect(o).toMatchObject({
      from: today,
      to: today,
      days: 1,
      previousFrom: dayAt(-1),
      previousTo: dayAt(-1),
    });
    expect(o.previous.orders).toBe(0);
    expect(o.previous.averageOrderValuePaise).toBeNull();
  });

  it("timeseries: one point per day; traffic is null (unavailable) on a day never rolled up; spend is paise", async () => {
    const t = await analyticsTimeseries(pool, { ...range(dayAt(-2), today), metric: "orders" });
    expect(t.points.map((p) => p.day)).toEqual([dayAt(-2), dayAt(-1), today]);
    expect(t.source).toBe("records");
    expect(t.points[2]?.value).toBeGreaterThan(0n);
    const spend = await analyticsTimeseries(pool, { ...range(today), metric: "spend" });
    expect(spend.unit).toBe("paise");
    const overview = await analyticsOverview(pool, range(today));
    expect(spend.points[0]?.value).toBe(overview.current.spendPaise);
    const traffic = await analyticsTimeseries(pool, { ...range(dayAt(-6), dayAt(-4)), metric: "page_views" });
    expect(traffic.source).toBe("events");
    expect(traffic.points).toEqual([
      { day: dayAt(-6), value: 18n },
      { day: dayAt(-5), value: 4n },
      { day: dayAt(-4), value: null },
    ]);
  });

  it("funnel: visitors → product views → cart adds → checkout starts → purchases, with step conversion", async () => {
    const day = dayAt(-7);
    const events: PlantedEvent[] = [];
    for (let i = 0; i < 10; i++) events.push({ day, name: "page_view", visitor: `f${i}` });
    for (let i = 0; i < 5; i++) events.push({ day, name: "product_view", visitor: `f${i}` });
    for (let i = 0; i < 2; i++) events.push({ day, name: "cart_add", visitor: `f${i}` });
    events.push({ day, name: "checkout_start", visitor: "f0", surface: "checkout" });
    events.push({ day, name: "purchase", visitor: "f0", surface: "checkout" });
    await plantEvents(events);
    await rollup(day);
    const f = await analyticsFunnel(pool, range(day));
    expect(f.steps).toEqual([
      { step: "visitors", visitors: 10, conversionFromPrevious: null },
      { step: "product_views", visitors: 5, conversionFromPrevious: 0.5 },
      { step: "cart_adds", visitors: 2, conversionFromPrevious: 0.4 },
      { step: "checkout_starts", visitors: 1, conversionFromPrevious: 0.5 },
      { step: "purchases", visitors: 1, conversionFromPrevious: 1 },
    ]);
    expect(f.overallConversion).toBe(0.1);
    expect(f.trafficDays).toBe(1);
  });

  it("R7.1/US-59: places come only from the suppressed rollup, with filters by country and region", async () => {
    const day = dayAt(-6);
    const countries = await analyticsPlaces(pool, {
      ...range(day),
      level: "country",
      country: null,
      region: null,
    });
    expect(countries.minVisitors).toBe(10);
    expect(countries.items).toEqual([
      { country: "IN", region: null, city: null, visitors: 17, signUps: 1, purchases: 0 },
      { country: "Other", region: null, city: null, visitors: 1, signUps: 0, purchases: 0 },
    ]);
    const cities = await analyticsPlaces(pool, { ...range(day), level: "city", country: "IN", region: "MH" });
    expect(cities.items.map((i) => [i.region, i.city, i.visitors])).toEqual([
      ["MH", "Mumbai", 12],
      ["MH", "Other", 3],
    ]);
    const regions = await analyticsPlaces(pool, {
      ...range(day),
      level: "region",
      country: "IN",
      region: null,
    });
    expect(regions.items.map((i) => [i.region, i.visitors, i.signUps])).toEqual([
      ["MH", 15, 0],
      ["Other", 2, 1],
    ]);
    expect(JSON.stringify([countries, cities, regions])).not.toMatch(/Kaza|Lonavala|Paris/);
    expect(
      await codeOf(
        analyticsPlaces(pool, { ...range(day), level: "street" as "city", country: null, region: null }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("top products, shops and categories by orders and spend from the order lines; shop name and handle, never an owner id", async () => {
    await ensureCategories(pool);
    const seeds = await published(pool, 3);
    const c = await creator(pool, seeds);
    const listing = await publishListing(pool, c, { pricePaise: 700n * RUPEE, quantity: 2 });
    const shopper = await user(pool);
    await payFor(
      pool,
      shopper,
      await checkout(pool, shopper, [{ id: listing.productId, versionId: "", pricePaise: 700n * RUPEE }], {
        [c.companyId]: "STANDARD",
      }),
    );
    const top = await analyticsTop(pool, { ...range(today), kind: "product", limit: 50 });
    const mine = top.items.find((i) => i.productId === listing.productId);
    expect(mine).toMatchObject({ orders: 1, units: 1, spendPaise: 700n * RUPEE, category: CATEGORY });
    expect(mine?.shop).toEqual({ name: "Moon Lamps", handle: c.handle });
    const shops = await analyticsTop(pool, { ...range(today), kind: "company", limit: 50 });
    expect(shops.items.find((i) => i.companyId === c.companyId)?.shop?.handle).toBe(c.handle);
    expect(shops.items.some((i) => i.shop === null)).toBe(true); // DeluluMart Originals
    const cats = await analyticsTop(pool, { ...range(today), kind: "category", limit: 50 });
    expect(cats.items.map((i) => i.category)).toContain(CATEGORY);
    const text = JSON.stringify([top, shops, cats], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const id of [c.u.userId, shopper.userId, buyer.userId]) expect(text).not.toContain(id);
  });

  it("listing_published is recorded by the database when a user's listing is first published, whatever the path", async () => {
    const { rows } = await pool.query<{ props: Record<string, string>; visitor_key: Buffer | null }>(
      "SELECT props, visitor_key FROM analytics.event WHERE name = 'listing_published'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.visitor_key).toBeNull();
    expect(Object.keys(rows[0]?.props ?? {}).sort()).toEqual(["category", "company_id", "product_id"]);
  });

  it("a creator unlock by the passport is recorded by the database (an unlock by spending is the web server's)", async () => {
    const before = Number(
      (
        await pool.query(
          "SELECT count(*) AS n FROM analytics.event WHERE name = 'creator_unlock' AND visitor_key IS NULL",
        )
      ).rows[0]?.n,
    );
    await creator(pool, await published(pool, 3));
    const after = Number(
      (
        await pool.query(
          "SELECT count(*) AS n FROM analytics.event WHERE name = 'creator_unlock' AND visitor_key IS NULL",
        )
      ).rows[0]?.n,
    );
    expect(after).toBe(before + 1);
    // a forged visitor-less event of any other name is refused by the table
    expect(
      await stateOf(
        pool,
        `INSERT INTO analytics.event (occurred_at, day, name, surface, signed_in, country, device_class)
         VALUES (date_trunc('minute', now()), (date_trunc('minute', now()) AT TIME ZONE 'UTC')::date, 'purchase',
                 'checkout', true, 'IN', 'mobile')`,
      ),
    ).toBe("23514");
  });
});

describe("0052: synthetic data for local development", () => {
  it("analytics.dev_seed_synthetic_events is owner-only and leaves only suppressed, rolled-up places", async () => {
    for (const role of ["app_web", "app_jobs", "app_pay", "research_ro", "npc_worker"]) {
      expect(await stateOf(pool, "SELECT analytics.dev_seed_synthetic_events(1)", [], { role }), role).toBe(
        "42501",
      );
    }
    const r = await pool.query<{ r: { days: number; events: number } }>(
      "SELECT analytics.dev_seed_synthetic_events(2) AS r",
    );
    expect(r.rows[0]?.r.days).toBe(2);
    expect(r.rows[0]?.r.events).toBeGreaterThan(100);
    const cities = await rollupRows(dayAt(-1), "city");
    expect(cities.map((c) => c.value)).toContain("IN|MH|Mumbai");
    expect(cities.map((c) => c.value).join()).not.toContain("Kaza");
    expect(await rollupRows(dayAt(-1), "category", "product_views")).not.toEqual([]);
  });
});
