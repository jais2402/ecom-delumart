// End-to-end check of the Super Admin analytics screens against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/analytics.spec.mjs          (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner.
//
// The analytics API is answered by Playwright route interception, so the journey is deterministic
// whatever the dev database holds, and the spec never needs the Super Admin role or `pnpm dev:setup`.
// What is real: the pages, the URL state, the request parameters (recorded and asserted), and the
// refusal of an anonymous visitor and of a signed-in non-admin by the live API. Set ADMIN_EMAIL to an
// account already made Super Admin (SUPER_ADMIN_EMAIL=... pnpm dev:setup) to also load the three
// pages unmocked as that account.
//
// Covers: overview with data (stats with arrow + text change, "no earlier data", partial-traffic
// note, chart with gaps, funnel), metric switch, range change in the URL and surviving a reload,
// places drill-down country > region > city and back, top tabs, empty state, error state with retry,
// and the non-admin refusal. Screenshots at 390px (phone) and 1280px (desktop), device scale 2.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-analytics-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const ADMIN_API = "**/api/v1/admin/analytics/**";

const results = [];
const shots = [];
let pages = {};

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    for (const [who, p] of Object.entries(pages)) {
      await p.screenshot({ path: join(SHOTS, `failed-${who}.png`), fullPage: true }).catch(() => {});
      console.log(`      (${who} was at ${p.url()})`);
    }
    console.log(
      `FAIL  ${name}\n      ${String(error?.message ?? error)
        .split("\n")
        .slice(0, 5)
        .join("\n      ")}`,
    );
    throw error;
  }
}

async function shot(page, name) {
  const who = page.viewportSize().width <= 400 ? "phone" : "desktop";
  const path = join(SHOTS, `${name}-${who}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

/** Screenshots of the page's current state at both sizes (the phone page is the one under test). */
async function shotBoth(name) {
  await shot(pages.phone, name);
  await pages.desktop.goto(pages.phone.url());
  await ready(pages.desktop);
  await shot(pages.desktop, name);
}

async function noOverflow(page, label) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label}: ${scroll} > ${client}`);
}

async function noOverflowAt320(page, label) {
  await page.setViewportSize({ width: 320, height: 800 });
  await noOverflow(page, `${label} (320)`);
  await page.setViewportSize(PHONE);
}

// ---------------------------------------------------------------------------------------------
// The mocked API
// ---------------------------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const span = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
const days = (from, to) => Array.from({ length: span(from, to) }, (_, i) => shift(from, i));
const err = (status, code, message) => ({
  status,
  json: { error: { code, message, retryable: false, details: {} } },
});

const TRAFFIC_METRICS = new Set([
  "visitors",
  "page_views",
  "searches",
  "product_views",
  "cart_adds",
  "checkout_starts",
]);

const places = {
  country: [
    { country: "IN", region: null, city: null, visitors: 8200, signUps: 150, purchases: 60 },
    { country: "US", region: null, city: null, visitors: 2100, signUps: 30, purchases: 9 },
    { country: "GB", region: null, city: null, visitors: 900, signUps: 12, purchases: 3 },
    { country: "ZZ", region: null, city: null, visitors: 400, signUps: 0, purchases: 0 },
    { country: "Other", region: null, city: null, visitors: 300, signUps: 1, purchases: 0 },
  ],
  region: [
    { country: "IN", region: "Maharashtra", city: null, visitors: 4100, signUps: 80, purchases: 31 },
    { country: "IN", region: "Karnataka", city: null, visitors: 2600, signUps: 40, purchases: 20 },
    { country: "IN", region: null, city: null, visitors: 900, signUps: 20, purchases: 6 },
    { country: "IN", region: "Other", city: null, visitors: 600, signUps: 10, purchases: 3 },
  ],
  city: [
    { country: "IN", region: "Maharashtra", city: "Mumbai", visitors: 2500, signUps: 50, purchases: 20 },
    { country: "IN", region: "Maharashtra", city: "Pune", visitors: 1200, signUps: 25, purchases: 9 },
    { country: "IN", region: "Maharashtra", city: null, visitors: 400, signUps: 5, purchases: 2 },
  ],
};

const top = {
  product: [
    {
      productId: "p1",
      name: "Pocket Cloud",
      category: "impossible-tech",
      shop: { name: "Cloud Works", handle: "cloud-works" },
      orders: 41,
      units: 44,
      spendPaise: "11000000",
    },
    {
      productId: "p2",
      name: "Moonlight Kettle",
      category: "impossible-tech",
      shop: null,
      orders: 30,
      units: 30,
      spendPaise: "7500000",
    },
    {
      productId: "p3",
      name: "Self-flying Kite",
      category: "impossible-tech",
      shop: { name: "Kite Club", handle: "kite-club" },
      orders: 12,
      units: 15,
      spendPaise: "1800000",
    },
  ],
  company: [
    { companyId: null, shop: null, orders: 60, units: 62, spendPaise: "15000000" },
    {
      companyId: "c1",
      shop: { name: "Cloud Works", handle: "cloud-works" },
      orders: 41,
      units: 44,
      spendPaise: "11000000",
    },
  ],
  category: [
    { category: "impossible-tech", orders: 90, units: 99, spendPaise: "26000000" },
    { category: "wearables", orders: 8, units: 8, spendPaise: "400000" },
  ],
};

/** Installs the mocked analytics API on a context. `mode` and `requests` are shared with the steps. */
function mockApi(context) {
  const api = {
    mode: "data",
    failMetric: null,
    requests: [],
    last: (name) => api.requests.filter((r) => r.name === name).at(-1),
  };
  context.route(ADMIN_API, async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split("/").pop();
    const q = Object.fromEntries(url.searchParams);
    api.requests.push({ name, q });
    if (api.mode === "deny") return route.fulfill(err(403, "FORBIDDEN", "You cannot do that."));
    if (api.mode === "failSeries" && name === "timeseries")
      return route.fulfill(err(500, "INTERNAL", "The analytics service is unavailable."));
    const empty = api.mode === "empty";
    const base = { from: q.from, to: q.to, days: span(q.from, q.to), asOf: new Date().toISOString() };
    if (name === "overview") {
      const zero = {
        visitors: 0,
        trafficDays: 0,
        signUps: 0,
        orders: 0,
        spendPaise: "0",
        averageOrderValuePaise: null,
        creatorUnlocks: 0,
        shopsRegistered: 0,
        listingsPublished: 0,
      };
      const n = base.days;
      return route.fulfill({
        json: {
          ...base,
          previousFrom: shift(q.from, -n),
          previousTo: shift(q.from, -1),
          current: empty
            ? zero
            : {
                visitors: 12840,
                trafficDays: Math.max(n - 5, 0),
                signUps: 212,
                orders: 96,
                spendPaise: "184500000",
                averageOrderValuePaise: "1921875",
                creatorUnlocks: 7,
                shopsRegistered: 3,
                listingsPublished: 41,
              },
          previous: empty
            ? zero
            : {
                visitors: 11000,
                trafficDays: n,
                signUps: 180,
                orders: 120,
                spendPaise: "150000000",
                averageOrderValuePaise: "1250000",
                creatorUnlocks: 7,
                shopsRegistered: 0,
                listingsPublished: 29,
              },
          trafficComputedAt: empty ? null : new Date().toISOString(),
        },
      });
    }
    if (name === "timeseries") {
      const traffic = TRAFFIC_METRICS.has(q.metric);
      const paise = q.metric === "spend";
      const points = days(q.from, q.to).map((day, i) => ({
        day,
        value:
          empty || (traffic && i % 7 === 3)
            ? null
            : String(paise ? (400 + ((i * 37) % 300)) * 10000 : 400 + ((i * 37) % 300)),
      }));
      return route.fulfill({
        json: {
          ...base,
          metric: q.metric,
          unit: paise ? "paise" : "count",
          source: traffic ? "events" : "records",
          points,
        },
      });
    }
    if (name === "funnel") {
      const v = empty ? [0, 0, 0, 0, 0] : [12840, 6420, 1284, 642, 96];
      const keys = ["visitors", "product_views", "cart_adds", "checkout_starts", "purchases"];
      return route.fulfill({
        json: {
          ...base,
          steps: keys.map((step, i) => ({
            step,
            visitors: v[i],
            conversionFromPrevious: i === 0 || v[i - 1] === 0 ? null : v[i] / v[i - 1],
          })),
          overallConversion: empty ? null : 96 / 12840,
          trafficDays: base.days,
        },
      });
    }
    if (name === "places") {
      const items = empty
        ? []
        : (places[q.level] ?? []).filter(
            (p) => (q.country ? p.country === q.country : true) && (q.region ? p.region === q.region : true),
          );
      return route.fulfill({
        json: {
          ...base,
          level: q.level,
          country: q.country ?? null,
          region: q.region ?? null,
          minVisitors: 5,
          items,
          trafficDays: base.days,
        },
      });
    }
    if (name === "top") {
      return route.fulfill({ json: { ...base, kind: q.kind, limit: 10, items: empty ? [] : top[q.kind] } });
    }
    return route.fulfill(err(404, "NOT_FOUND", "unknown"));
  });
  return api;
}

const ready = async (page) => {
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.waitForLoadState("networkidle");
};
/** Waits until the last request of that endpoint has the given query (requests follow the URL a moment later). */
async function lastQuery(api, name, expected) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const q = api.last(name)?.q;
    if (q && Object.entries(expected).every(([k, v]) => q[k] === v)) return q;
    if (Date.now() > deadline)
      assert.fail(`no ${name} request with ${JSON.stringify(expected)}; last was ${JSON.stringify(q)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const h1 = (page, name) => page.getByRole("heading", { level: 1, name });

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------
const browser = await chromium.launch();
async function newContext(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, baseURL: BASE });
  return context;
}
try {
  const phoneCtx = await newContext(PHONE);
  const deskCtx = await newContext(DESKTOP);
  const api = mockApi(phoneCtx);
  const deskApi = mockApi(deskCtx);
  const phone = await phoneCtx.newPage();
  const desktop = await deskCtx.newPage();
  pages = { phone, desktop };
  const sync = (mode) => {
    api.mode = mode;
    deskApi.mode = mode;
  };

  await step("overview: totals, change in words, partial traffic note, chart, funnel", async () => {
    await phone.goto("/console/analytics");
    await ready(phone);
    await h1(phone, "Analytics").waitFor();
    await phone.getByRole("navigation", { name: "Commerce Console" }).waitFor();
    // the default range is the last 30 UTC days and is written to the requests
    const q = api.last("overview").q;
    assert.deepEqual(q, { from: shift(today, -29), to: today });
    const totals = phone.getByRole("list", { name: "Totals for the period" });
    await totals.waitFor();
    const text = await totals.innerText();
    for (const label of [
      "Daily visitors (summed)",
      "Sign-ups",
      "Orders",
      "Spend (fictional money)",
      "Average order value",
      "Creator unlocks",
      "Shops registered",
      "Listings published",
    ]) {
      assert.ok(text.includes(label), `missing stat ${label}`);
    }
    assert.ok(text.includes("Up 16.7% vs previous period"), "visitors change in words");
    assert.ok(text.includes("Down 20.0% vs previous period"), "orders change in words");
    assert.ok(text.includes("No change vs previous period"), "unlocks flat");
    assert.ok(text.includes("No earlier data"), "zero previous is not a percentage");
    assert.ok(text.includes("₹18,45,000"), "spend is exact fictional rupees");
    await phone.getByText("Traffic data covers 25 of 30 days").waitFor();
    await phone
      .getByText(/As of /)
      .first()
      .waitFor();
    await phone.getByText("Fictional money", { exact: true }).first().waitFor();
    // chart: gaps are named, never zero
    const summary = phone.getByTestId("chart-summary");
    assert.match(await summary.innerText(), /have no figure yet and are left blank/);
    await phone.getByRole("img", { name: /Daily visitors \(summed\) per day/ }).waitFor();
    const gapRow = phone
      .getByRole("table", { name: /Daily visitors \(summed\) per day/ })
      .getByRole("row", { name: /Not available yet/ })
      .first();
    await gapRow.waitFor();
    // funnel
    const steps = phone.getByRole("list", { name: "Visitors to purchases: steps" });
    const funnel = await steps.innerText();
    assert.ok(funnel.includes("50% of the step before"));
    assert.ok(funnel.includes("Purchases"));
    await phone.getByText(/Overall: 0.7% of the first step reached the last/).waitFor();
    await noOverflowAt320(phone, "/console/analytics");
    await shotBoth("overview");
  });

  await step("overview: metric switch asks the API for that metric and is kept in the URL", async () => {
    await phone.goto("/console/analytics");
    await ready(phone);
    const select = phone.getByLabel("Metric");
    await select.selectOption("orders");
    await phone.waitForURL(/metric=orders/);
    await phone.getByRole("img", { name: /Orders per day/ }).waitFor();
    await lastQuery(api, "timeseries", { metric: "orders" });
    assert.doesNotMatch(
      await phone.getByTestId("chart-summary").innerText(),
      /no figure yet/,
      "records have no gaps",
    );
    await select.selectOption("spend");
    await phone.waitForURL(/metric=spend/);
    await phone.getByRole("img", { name: /Spend \(fictional money\) per day/ }).waitFor();
    assert.match(await phone.getByTestId("chart-summary").innerText(), /Total ₹/);
    await shotBoth("overview-spend");
  });

  await step("overview: range change is in the URL, the requests and survives a reload", async () => {
    await phone.goto("/console/analytics");
    await ready(phone);
    await phone.getByRole("button", { name: "Last 7 days" }).click();
    const from7 = shift(today, -6);
    await phone.waitForURL((u) => u.searchParams.get("from") === from7 && u.searchParams.get("to") === today);
    await phone.waitForLoadState("networkidle");
    assert.deepEqual(await lastQuery(api, "overview", { from: from7, to: today }), {
      from: from7,
      to: today,
    });
    await lastQuery(api, "funnel", { from: from7 });
    await lastQuery(api, "timeseries", { from: from7 });
    await phone
      .getByRole("button", { name: "Last 7 days" })
      .and(phone.locator('[aria-pressed="true"]'))
      .waitFor();
    // custom range
    await phone.getByLabel("From", { exact: true }).fill(shift(today, -59));
    await phone.getByLabel("To", { exact: true }).fill(shift(today, -30));
    await phone.getByRole("button", { name: "Apply dates" }).click();
    await phone.waitForURL(
      (u) =>
        u.searchParams.get("from") === shift(today, -59) && u.searchParams.get("to") === shift(today, -30),
    );
    await phone.waitForLoadState("networkidle");
    await phone.getByRole("img", { name: /per day/ }).waitFor();
    // reload keeps it
    await phone.reload();
    await ready(phone);
    assert.equal(await phone.getByLabel("From", { exact: true }).inputValue(), shift(today, -59));
    await lastQuery(api, "overview", { from: shift(today, -59), to: shift(today, -30) });
    // a refused range is explained and sends nothing
    const before = api.requests.length;
    await phone.getByLabel("From", { exact: true }).fill(shift(today, -2));
    await phone.getByLabel("To", { exact: true }).fill(shift(today, -9));
    await phone.getByRole("button", { name: "Apply dates" }).click();
    await phone.getByRole("alert").filter({ hasText: "on or before" }).waitFor();
    assert.equal(api.requests.length, before);
  });

  await step("places: drill country > region > city and back through the breadcrumb", async () => {
    await phone.goto("/console/analytics/places");
    await ready(phone);
    await h1(phone, "Usage by place").waitFor();
    assert.equal(api.last("places").q.level, "country");
    const table = phone.getByRole("table", { name: "Usage by country" });
    await table.waitFor();
    const t = await table.innerText();
    assert.ok(
      t.includes("India") &&
        t.includes("United States") &&
        t.includes("Unknown location") &&
        t.includes("Other (small places combined)"),
    );
    assert.ok(t.includes("Daily visitors (summed)"));
    // unknown and folded rows are plain text, not buttons
    assert.equal(await table.getByRole("button").count(), 3);
    await phone.getByText(/fewer than 5 daily visitors are combined/).waitFor();
    await shotBoth("places-country");
    await phone.goto(pages.phone.url());
    await ready(phone);
    await phone.getByRole("button", { name: "Show regions in India" }).click();
    await phone.waitForURL(/level=region&country=IN/);
    await phone.getByRole("table", { name: "Usage by region" }).waitFor();
    await lastQuery(api, "places", { level: "region", country: "IN" });
    const regions = await phone.getByRole("table", { name: "Usage by region" }).innerText();
    assert.ok(
      regions.includes("Maharashtra") &&
        regions.includes("Unknown") &&
        regions.includes("Other (small places combined)"),
    );
    await phone.getByRole("button", { name: "Show cities in Maharashtra" }).click();
    await phone.waitForURL(/level=city&country=IN&region=Maharashtra/);
    await phone.getByRole("table", { name: "Usage by city" }).waitFor();
    await lastQuery(api, "places", { level: "city", region: "Maharashtra" });
    assert.equal(
      await phone.getByRole("table", { name: "Usage by city" }).getByRole("button").count(),
      0,
      "cities are the last level",
    );
    await phone.getByText("Pune").waitFor();
    const crumbs = phone.getByRole("navigation", { name: "Breadcrumb" });
    assert.equal(await crumbs.getByRole("link").count(), 2);
    await noOverflowAt320(phone, "/console/analytics/places city level");
    await shotBoth("places-city");
    // reload keeps the level; back via breadcrumbs
    await phone.reload();
    await phone.getByRole("table", { name: "Usage by city" }).waitFor();
    await crumbs.getByRole("link", { name: "India" }).click();
    await phone.getByRole("table", { name: "Usage by region" }).waitFor();
    await crumbs.getByRole("link", { name: "All countries" }).click();
    await phone.getByRole("table", { name: "Usage by country" }).waitFor();
    assert.ok(!phone.url().includes("level="), "the country level has no level in the URL");
  });

  await step("top: tabs for products, shops and categories", async () => {
    await phone.goto("/console/analytics/top");
    await ready(phone);
    await h1(phone, "Top sellers").waitFor();
    assert.equal(api.last("top").q.kind, "product");
    const products = phone.getByRole("table", { name: "Top products, by spend" });
    await products.waitFor();
    const p = await products.innerText();
    assert.ok(p.includes("Pocket Cloud") && p.includes("Cloud Works") && p.includes("DeluluMart Originals"));
    assert.ok(p.includes("₹1,10,000"), "spend as exact fictional rupees");
    await phone.getByText(/Fictional money: every amount here is game money/).waitFor();
    await shotBoth("top-products");
    await phone.goto("/console/analytics/top");
    await ready(phone);
    await phone.getByRole("tab", { name: "Shops" }).click();
    await phone.waitForURL(/kind=company/);
    const shops = phone.getByRole("table", { name: "Top shops, by spend" });
    await shops.waitFor();
    assert.ok((await shops.innerText()).includes("DeluluMart Originals"));
    await lastQuery(api, "top", { kind: "company" });
    await phone.getByRole("tab", { name: "Categories" }).click();
    await phone.waitForURL(/kind=category/);
    const cats = phone.getByRole("table", { name: "Top categories, by spend" });
    await cats.waitFor();
    await lastQuery(api, "top", { kind: "category" });
    await noOverflowAt320(phone, "/console/analytics/top");
    await shotBoth("top-categories");
  });

  await step("empty state: No data for this period yet in every panel", async () => {
    sync("empty");
    for (const [path, name] of [
      ["/console/analytics", "overview-empty"],
      ["/console/analytics/places", "places-empty"],
      ["/console/analytics/top", "top-empty"],
    ]) {
      await phone.goto(path);
      await ready(phone);
      await phone.getByRole("heading", { name: "No data for this period yet" }).first().waitFor();
      if (path === "/console/analytics") {
        assert.equal(
          await phone.getByRole("heading", { name: "No data for this period yet" }).count(),
          2,
          "chart and funnel are empty",
        );
      }
      await shotBoth(name);
    }
    sync("data");
  });

  await step("error state: a failed panel says so, offers Try again, and recovers", async () => {
    sync("failSeries");
    await phone.goto("/console/analytics");
    await ready(phone);
    await phone.getByRole("alert").filter({ hasText: "The analytics service is unavailable." }).waitFor();
    // the rest of the screen still works
    await phone.getByRole("list", { name: "Totals for the period" }).waitFor();
    await phone.getByRole("list", { name: "Visitors to purchases: steps" }).waitFor();
    await shotBoth("overview-error");
    await phone.goto("/console/analytics");
    await ready(phone);
    sync("data");
    await phone.getByRole("button", { name: "Try again" }).click();
    await phone.getByRole("img", { name: /per day/ }).waitFor();
    assert.equal(await phone.getByText("That did not load").count(), 0);
  });

  await step("non-admin: the API's 403 shows only Not available (all three pages)", async () => {
    sync("deny");
    for (const path of ["/console/analytics", "/console/analytics/places", "/console/analytics/top"]) {
      await phone.goto(path);
      await ready(phone);
      await h1(phone, "Not available").waitFor();
      assert.equal(
        await phone.getByText("Analytics", { exact: true }).count(),
        0,
        "nothing about the screen leaks",
      );
      assert.equal(await phone.getByRole("navigation", { name: "Commerce Console" }).count(), 0);
    }
    await shotBoth("not-available");
    sync("data");
  });

  // Live: no mocks. An anonymous visitor and a signed-in non-admin are refused by the real API.
  await step("non-admin live: anonymous and signed-in non-admin both see Not available", async () => {
    const ctx = await newContext(PHONE);
    const page = await ctx.newPage();
    pages = { ...pages, live: page };
    for (const path of ["/console/analytics", "/console/analytics/places", "/console/analytics/top"]) {
      await page.goto(path);
      await ready(page);
      await h1(page, "Not available").waitFor();
    }
    let signedIn = false;
    try {
      await page.evaluate(
        async (email) => {
          const token = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
            .csrfToken;
          const r = await fetch("/api/v1/auth/dev/sign-in", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", "x-csrf-token": token },
            body: JSON.stringify({ email }),
          });
          if (!r.ok) throw new Error(`sign-in ${r.status}`);
        },
        `analytics-user-${Date.now().toString(36)}@example.com`,
      );
      signedIn = true;
    } catch (error) {
      console.log(
        `      (could not sign a plain user in: ${error.message}; only the anonymous refusal was checked)`,
      );
    }
    if (signedIn) {
      for (const path of ["/console/analytics", "/console/analytics/places", "/console/analytics/top"]) {
        await page.goto(path);
        await ready(page);
        await h1(page, "Not available").waitFor();
      }
    }
    await shot(page, "not-available-live");
    await ctx.close();
    delete pages.live;
  });

  if (process.env.ADMIN_EMAIL) {
    await step("live Super Admin (ADMIN_EMAIL): the three pages load unmocked", async () => {
      const ctx = await newContext(PHONE);
      const page = await ctx.newPage();
      await page.goto("/");
      await page.evaluate(async (email) => {
        const token = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
          .csrfToken;
        const r = await fetch("/api/v1/auth/dev/sign-in", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": token },
          body: JSON.stringify({ email }),
        });
        if (!r.ok) throw new Error(`sign-in ${r.status}`);
      }, process.env.ADMIN_EMAIL);
      for (const [path, title] of [
        ["/console/analytics", "Analytics"],
        ["/console/analytics/places", "Usage by place"],
        ["/console/analytics/top", "Top sellers"],
      ]) {
        await page.goto(path);
        await ready(page);
        await h1(page, title).waitFor();
        await page
          .getByRole("heading", { name: "That did not load" })
          .waitFor({ state: "detached", timeout: 2000 });
        await shot(page, `live-admin-${title.toLowerCase().replaceAll(" ", "-")}`);
      }
      await ctx.close();
    });
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
console.log(`Screenshots (${shots.length}) in ${SHOTS}`);
for (const path of shots) console.log(`  ${path}`);
if (failed) process.exitCode = 1;
