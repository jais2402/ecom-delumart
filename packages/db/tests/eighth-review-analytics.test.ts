import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyticsFunnel,
  analyticsPlaces,
  type RecordEventInput,
  recordEvent,
  todaySalt,
} from "../src/analytics";
import { purgeAnalyticsEvents, rollupAnalytics } from "../src/jobs";
import { MIGRATIONS_DIR, migrate } from "../src/migrate";
import { codeOf, user } from "./checkout-fixtures";
import {
  ADMIN_URL,
  createTestDatabase,
  inRolledBackTx,
  stateOf,
  type TestDatabase,
  type TestUser,
} from "./helpers";
import { creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

const SERVER = ["purchase", "sign_up", "creator_unlock", "shop_registered", "listing_published"];
const APP_ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro", "anon", "authenticated"];

let db: TestDatabase;
let pool: pg.Pool;
let admin: TestUser;
let buyer: TestUser;
let today: string;

const dayAt = (offset: number): string => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const key = (label: string, bytes: number): Buffer =>
  createHash("sha256").update(label).digest().subarray(0, bytes);

function event(overrides: Partial<RecordEventInput> = {}): RecordEventInput {
  return {
    authSessionId: null,
    name: "page_view",
    surface: "shop",
    visitorKey: randomBytes(16),
    placeKey: randomBytes(8),
    country: "IN",
    region: "KA",
    city: "Bengaluru",
    deviceClass: "desktop",
    props: {},
    ...overrides,
  };
}
const serverEvent = (name: string, u: TestUser, props: Record<string, string | number> = {}) =>
  event({
    name,
    surface: "checkout",
    authSessionId: u.authSessionId,
    visitorKey: null,
    placeKey: null,
    props,
  });

interface Planted {
  day: string;
  name: string;
  visitor: string;
  /** the address prefix's label; defaults to the visitor's own */
  prefix?: string;
  city?: string;
}

/** Past-dated events, written as the owner (browser events with keys; server events without). */
async function plant(events: readonly Planted[]): Promise<void> {
  for (const [i, e] of events.entries()) {
    const server = SERVER.includes(e.name);
    await pool.query(
      `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, place_key, signed_in, country, region,
                                    city, device_class, props)
       VALUES (($1::date)::timestamp AT TIME ZONE 'UTC' + make_interval(mins => $2), $1::date, $3, 'shop', $4, $5,
               false, 'IN', 'MH', $6, 'mobile', '{}')`,
      [
        e.day,
        server ? 60 * (i % 23) : i % 1400,
        e.name,
        server ? null : key(e.visitor, 16),
        server ? null : key(`prefix:${e.prefix ?? e.visitor}`, 8),
        e.city ?? "Mumbai",
      ],
    );
  }
}

const rollup = (day: string) => pool.query("SELECT analytics.rollup_day($1::date)", [day]);
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

describe("eighth review, major 2: server-side events cannot be tied to a person", () => {
  it("major 2: purchase, sign_up, creator_unlock and shop_registered are stored with no visitor or place key, in their hour, with no identifying prop", async () => {
    expect(await recordEvent(pool, serverEvent("purchase", buyer, { amount_bucket: "10k_1l" }))).toBe(true);
    expect(await recordEvent(pool, serverEvent("sign_up", buyer))).toBe(true);
    expect(await recordEvent(pool, serverEvent("creator_unlock", buyer))).toBe(true);
    // a visitor key, a place key or an identifying prop on a server event is refused
    for (const bad of [
      serverEvent("purchase", buyer, { amount_bucket: "10k_1l", item_count: 2 }),
      { ...serverEvent("purchase", buyer, { amount_bucket: "10k_1l" }), visitorKey: randomBytes(16) },
      { ...serverEvent("sign_up", buyer), placeKey: randomBytes(8) },
      serverEvent("shop_registered", buyer, { company_id: "11111111-1111-4111-8111-111111111111" }),
    ]) {
      expect(await codeOf(recordEvent(pool, bad)), JSON.stringify(bad.props)).toBe("VALIDATION_FAILED");
    }
    const { rows } = await pool.query<{
      name: string;
      vk: boolean;
      pk: boolean;
      hour: boolean;
      props: unknown;
    }>(
      `SELECT name, visitor_key IS NULL AS vk, place_key IS NULL AS pk,
              occurred_at = date_trunc('hour', occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour, props
         FROM analytics.event WHERE name IN ('purchase', 'sign_up', 'creator_unlock') ORDER BY id`,
    );
    expect(rows).toEqual([
      { name: "purchase", vk: true, pk: true, hour: true, props: { amount_bucket: "10k_1l" } },
      { name: "sign_up", vk: true, pk: true, hour: true, props: {} },
      { name: "creator_unlock", vk: true, pk: true, hour: true, props: {} },
    ]);
  });

  it("major 2: shop_registered and listing_published name no company or product", async () => {
    await ensureCategories(pool);
    const c = await creator(pool, await published(pool, 3));
    await publishListing(pool, c);
    expect(
      await recordEvent(pool, {
        ...serverEvent("shop_registered", c.u),
        surface: "studio",
      }),
    ).toBe(true);
    // someone without a company cannot record one
    expect(await codeOf(recordEvent(pool, serverEvent("shop_registered", buyer)))).toBe("VALIDATION_FAILED");
    const { rows } = await pool.query<{ name: string; props: Record<string, unknown> }>(
      "SELECT name, props FROM analytics.event WHERE name IN ('shop_registered', 'listing_published') ORDER BY id",
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["listing_published", "shop_registered"]);
    for (const r of rows) {
      expect(
        Object.keys(r.props).filter((k) => k !== "category"),
        r.name,
      ).toEqual([]);
    }
  });

  it("major 2: no server-side event row anywhere has a visitor key, a place key, a sub-hour time or an identifying prop; the table refuses one whoever writes", async () => {
    const { rows } = await pool.query<{ n: string; total: string }>(
      `SELECT count(*) FILTER (WHERE visitor_key IS NOT NULL OR place_key IS NOT NULL
                                 OR mod(extract(epoch FROM occurred_at), 3600) <> 0
                                 OR props ?| ARRAY['company_id', 'product_id', 'item_count', 'user_id'])::text AS n,
              count(*)::text AS total
         FROM analytics.event WHERE name = ANY ($1::text[])`,
      [SERVER],
    );
    expect(Number(rows[0]?.total)).toBeGreaterThanOrEqual(5);
    expect(rows[0]?.n).toBe("0");
    for (const [sql, params] of [
      [
        `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, device_class, props)
         VALUES (date_trunc('hour', now()), (date_trunc('hour', now()) AT TIME ZONE 'UTC')::date, 'purchase',
                 'checkout', $1, true, 'IN', 'mobile', '{}')`,
        [randomBytes(16)],
      ],
      [
        `INSERT INTO analytics.event (occurred_at, day, name, surface, signed_in, country, device_class, props)
         VALUES (date_trunc('hour', now()), (date_trunc('hour', now()) AT TIME ZONE 'UTC')::date, 'shop_registered',
                 'studio', true, 'IN', 'mobile', '{"company_id": "11111111-1111-4111-8111-111111111111"}')`,
        [],
      ],
      [
        `INSERT INTO analytics.event (occurred_at, day, name, surface, signed_in, country, device_class, props)
         VALUES (date_trunc('hour', now()) + interval '1 minute',
                 ((date_trunc('hour', now()) + interval '1 minute') AT TIME ZONE 'UTC')::date, 'sign_up',
                 'account', true, 'IN', 'mobile', '{}')`,
        [],
      ],
    ] as const) {
      expect(await stateOf(pool, sql, [...params]), sql).toBe("23514");
    }
  });

  it("major 2: the migration rewrites the rows written before it (keys nulled, props stripped, time to the hour)", async () => {
    const name = `delulu_test_${randomBytes(6).toString("hex")}`;
    const dir = await mkdtemp(join(tmpdir(), "delulu-0060-"));
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const old = new pg.Pool({ connectionString: url.toString(), max: 2 });
    try {
      for (const f of await readdir(MIGRATIONS_DIR)) {
        if (/^\d{4}_.*\.sql$/.test(f) && f < "0061") await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
      }
      await migrate(old, { directory: dir });
      await old.query(
        `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, city,
                                      device_class, props)
         VALUES ('2026-11-20T10:17:00Z', '2026-11-20', 'shop_registered', 'studio', $1, true, 'IN', 'MH', 'Mumbai',
                 'mobile', '{"company_id": "11111111-1111-4111-8111-111111111111"}'),
                ('2026-11-20T10:18:00Z', '2026-11-20', 'purchase', 'checkout', $1, true, 'IN', 'Maharashtra',
                 'Pune 411001', 'mobile', '{"item_count": 3, "amount_bucket": "1k_10k"}'),
                ('2026-11-20T10:19:00Z', '2026-11-20', 'search', 'shop', $1, false, 'IN', 'MH', 'Mumbai', 'mobile',
                 '{"category": "made-up", "result_count_bucket": "0"}'),
                ('2026-11-20T10:20:00Z', '2026-11-20', 'listing_published', 'studio', NULL, true, 'ZZ', NULL, NULL,
                 'unknown', '{"product_id": "11111111-1111-4111-8111-111111111111", "company_id": "11111111-1111-4111-8111-111111111111"}')`,
        [randomBytes(16)],
      );
      await migrate(old);
      const { rows } = await old.query<{
        name: string;
        vk: boolean;
        at: string;
        region: string | null;
        city: string | null;
        props: unknown;
      }>(
        `SELECT name, visitor_key IS NULL AS vk, to_char(occurred_at AT TIME ZONE 'UTC', 'HH24:MI') AS at, region, city,
                props FROM analytics.event ORDER BY id`,
      );
      expect(rows).toEqual([
        { name: "shop_registered", vk: true, at: "10:00", region: "MH", city: "Mumbai", props: {} },
        {
          name: "purchase",
          vk: true,
          at: "10:00",
          region: null,
          city: null,
          props: { amount_bucket: "1k_10k" },
        },
        {
          name: "search",
          vk: false,
          at: "10:19",
          region: "MH",
          city: "Mumbai",
          props: { result_count_bucket: "0" },
        },
        { name: "listing_published", vk: true, at: "10:00", region: null, city: null, props: {} },
      ]);
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("major 2 (funnel): the purchases step counts purchase events, the others daily distinct visitors", async () => {
    const day = dayAt(-9);
    const events: Planted[] = [];
    for (let i = 0; i < 10; i++) events.push({ day, name: "page_view", visitor: `fu${i}` });
    for (let i = 0; i < 4; i++) events.push({ day, name: "checkout_start", visitor: `fu${i}` });
    for (let i = 0; i < 3; i++) events.push({ day, name: "purchase", visitor: "" });
    await plant(events);
    await rollup(day);
    const f = await analyticsFunnel(pool, range(day));
    expect(f.steps.map((s) => [s.step, s.visitors, s.unit])).toEqual([
      ["visitors", 10, "visitors"],
      ["product_views", 0, "visitors"],
      ["cart_adds", 0, "visitors"],
      ["checkout_starts", 4, "visitors"],
      ["purchases", 3, "events"],
    ]);
    expect(f.overallConversion).toBe(0.3);
  });
});

describe("eighth review, minor 3: small-count suppression", () => {
  it("minor 3a: the place minimum is at least 10: a configuration below it is refused, and the functions floor it anyway", async () => {
    expect(
      await stateOf(
        pool,
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT values || '{"analytics": {"place_min_visitors": 1}}', now(), 'too low' FROM core.config_version WHERE id = 1`,
      ),
    ).toBe("23514");
    const floored = await inRolledBackTx(pool, async (c) => {
      await c.query("ALTER TABLE core.config_version DROP CONSTRAINT config_analytics_minimums");
      await c.query(
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT values || '{"analytics": {"place_min_visitors": 1, "cell_min_count": 1}}', now() - interval '1 second', 'x'
           FROM core.config_version WHERE id = 1`,
      );
      return (
        await c.query<{ k: number; c: number }>(
          "SELECT analytics.place_min_visitors() AS k, analytics.cell_min_count() AS c",
        )
      ).rows[0];
    });
    expect(floored).toEqual({ k: 10, c: 5 });
  });

  it("minor 3c: one person behind one address prefix with many user agents does not make a place reportable", async () => {
    const day = dayAt(-10);
    const events: Planted[] = [];
    // Lonavala: twelve visitor keys, one address prefix; Nagpur: twelve prefixes
    for (let i = 0; i < 12; i++)
      events.push({
        day,
        name: "page_view",
        visitor: `lon-ua-${i}`,
        prefix: "lonavala-home",
        city: "Lonavala",
      });
    for (let i = 0; i < 12; i++) events.push({ day, name: "page_view", visitor: `nag-${i}`, city: "Nagpur" });
    await plant(events);
    await rollup(day);
    const cities = await analyticsPlaces(pool, { ...range(day), level: "city", country: "IN", region: "MH" });
    expect(cities.items.map((i) => [i.city, i.visitors, i.suppressed])).toEqual([
      ["Nagpur", 12, false],
      ["Other", null, true],
    ]);
    expect(JSON.stringify(cities)).not.toContain("Lonavala");
  });

  it("minor 3b: a shown place's sign-up and purchase cells are null between 1 and the cell minimum (5)", async () => {
    const day = dayAt(-11);
    const events: Planted[] = [];
    for (let i = 0; i < 12; i++) events.push({ day, name: "page_view", visitor: `ak-${i}`, city: "Akola" });
    for (let i = 0; i < 3; i++) events.push({ day, name: "sign_up", visitor: "", city: "Akola" });
    for (let i = 0; i < 5; i++) events.push({ day, name: "purchase", visitor: "", city: "Akola" });
    for (let i = 0; i < 12; i++) events.push({ day, name: "page_view", visitor: `wa-${i}`, city: "Wardha" });
    await plant(events);
    await rollup(day);
    const cities = await analyticsPlaces(pool, { ...range(day), level: "city", country: "IN", region: "MH" });
    expect(cities.minCellCount).toBe(5);
    expect(cities.items).toEqual([
      {
        country: "IN",
        region: "MH",
        city: "Akola",
        visitors: 12,
        signUps: null,
        purchases: 5,
        suppressed: false,
      },
      {
        country: "IN",
        region: "MH",
        city: "Wardha",
        visitors: 12,
        signUps: 0,
        purchases: 0,
        suppressed: false,
      },
    ]);
  });

  it("minor 3c: the rollup job forgets the place keys of a day rolled up and at least two days old; that day's rollup is then final", async () => {
    const old = dayAt(-3);
    const recent = dayAt(-1);
    await plant([
      { day: old, name: "page_view", visitor: "fg-old" },
      { day: recent, name: "page_view", visitor: "fg-recent" },
    ]);
    await rollup(old);
    await rollupAnalytics(pool);
    const { rows } = await pool.query<{ day: string; keys: string }>(
      `SELECT day::text, count(place_key)::text AS keys FROM analytics.event
        WHERE day IN ($1::date, $2::date) AND name = 'page_view' GROUP BY day ORDER BY day`,
      [old, recent],
    );
    expect(rows.map((r) => [r.day, Number(r.keys) > 0])).toEqual([
      [old, false],
      [recent, true],
    ]);
    // the day's figures were kept, and it is never recomputed from keyless events
    expect(await codeOf(rollup(old))).toBe("DM001"); // core.fail VALIDATION_FAILED, raw SQL
    const run = await pool.query<{ final: boolean }>(
      "SELECT final FROM analytics.rollup_run WHERE day = $1",
      [old],
    );
    expect(run.rows).toEqual([{ final: true }]);
    // nothing else about an event may change, even as the owner
    expect(await stateOf(pool, "UPDATE analytics.event SET place_key = NULL WHERE day = $1", [recent])).toBe(
      "DM001",
    );
  });
});

describe("eighth review, minor 6: the daily salt", () => {
  it("minor 6: app_web gets only today's salt (created once); no application role reads the salt table; the purge deletes old salts", async () => {
    const a = await todaySalt(pool);
    const b = await todaySalt(pool);
    expect(a.day).toBe(today);
    expect(a.salt.length).toBe(32);
    expect(b.salt.equals(a.salt)).toBe(true);
    for (const role of APP_ROLES) {
      expect(await stateOf(pool, "SELECT * FROM analytics.daily_salt", [], { role }), role).toBe("42501");
    }
    for (const role of ["app_pay", "app_jobs", "npc_worker", "research_ro"]) {
      expect(await stateOf(pool, "SELECT * FROM analytics.today_salt()", [], { role }), role).toBe("42501");
    }
    // the function takes no day: an old day's salt cannot be asked for
    const args = await pool.query<{ n: number }>(
      "SELECT pronargs AS n FROM pg_proc WHERE oid = 'analytics.today_salt'::regproc",
    );
    expect(args.rows).toEqual([{ n: 0 }]);
    await pool.query("INSERT INTO analytics.daily_salt (day, salt) VALUES ($1, $3), ($2, $3)", [
      dayAt(-2),
      dayAt(-1),
      randomBytes(32),
    ]);
    await purgeAnalyticsEvents(pool);
    const left = await pool.query<{ day: string }>("SELECT day::text FROM analytics.daily_salt ORDER BY day");
    expect(left.rows.map((r) => r.day)).toEqual([dayAt(-1), today]);
  });
});

describe("eighth review, minor 5: no free text in a place or a category", () => {
  it("minor 5: a region is a subdivision code; a city is letters only; search carries no category; other categories are catalog slugs", async () => {
    for (const bad of [
      { region: "Maharashtra" },
      { region: "mh" },
      { region: "MH1X" },
      { city: "Pune 411001" },
      { city: "Call 98765" },
      { city: "a@b.example" },
      { city: "Delhi (NCR)" },
      { name: "search", props: { result_count_bucket: "0", category: "gadgets" } },
    ] satisfies Partial<RecordEventInput>[]) {
      expect(await codeOf(recordEvent(pool, event(bad))), JSON.stringify(bad)).toBe("VALIDATION_FAILED");
    }
    for (const ok of ["Navi Mumbai", "मुंबई", "São Paulo", "O'Fallon", "St. Louis", "Winston-Salem"]) {
      expect(await recordEvent(pool, event({ city: ok })), ok).toBe(true);
    }
    // the table refuses free text whoever writes
    expect(
      await stateOf(
        pool,
        `INSERT INTO analytics.event (occurred_at, day, name, surface, visitor_key, signed_in, country, region, device_class)
         VALUES (date_trunc('minute', now()), (date_trunc('minute', now()) AT TIME ZONE 'UTC')::date, 'page_view', 'shop',
                 $1, false, 'IN', 'call me maybe', 'mobile')`,
        [randomBytes(16)],
      ),
    ).toBe("23514");
    // a product's category reaches an event only when it is a catalog category
    const [p] = await published(pool, 1);
    const k = randomBytes(16);
    expect(
      await recordEvent(
        pool,
        event({ name: "product_view", visitorKey: k, props: { product_id: p?.id ?? "" } }),
      ),
    ).toBe(true);
    const { rows } = await pool.query<{ props: Record<string, unknown> }>(
      "SELECT props FROM analytics.event WHERE visitor_key = $1",
      [k],
    );
    expect(rows[0]?.props).toEqual({ product_id: p?.id }); // 'gadgets' is not in core.category here
  });
});
