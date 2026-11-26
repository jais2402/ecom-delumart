// End-to-end check of the Super Admin's delayed actions and versioned configuration against a
// running dev server (AUTH_PROVIDER=dev), docs/decisions.md #16:
//   DEV_DB_NAME=delulu_dev node tests/e2e/admin-actions.spec.mjs   (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner. 390px viewport.
//
// The Super Admin opens Configuration, sees the settings the allow-list names, proposes a fee
// change (the form refuses a short reason and an out-of-range value), sees it waiting on Pending
// actions with a countdown, cancels it with a reason (it moves to History as Cancelled), proposes
// it again, and then the owner-only local helper (`pnpm dev:expedite-admin-actions`, refuses any
// non-local database, no app route) makes it due and runs the signed jobs endpoint: the action is
// Applied, the Configuration page shows the new current value, and a signed-out visitor sees the
// store news banner on the storefront; the public answer names no person and no reason. A
// signed-in non-admin and a visitor see only "Not available". No horizontal overflow at 320px.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-admin-actions-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const letters = (n) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const tag = letters(8);
const phone = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const email = (who) => `${who}-${tag}@example.com`;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? email("admin");
const REASON = `Seasonal fee review ${tag}`;

const results = [];
const shots = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    for (const [who, p] of Object.entries({ admin, other, visitor })) {
      await p.screenshot({ path: join(SHOTS, `failed-${who}.png`), fullPage: true }).catch(() => {});
      console.log(`      (${who} was at ${p.url()})`);
    }
    console.log(
      `FAIL  ${name}\n      ${String(error?.message ?? error)
        .split("\n")
        .slice(0, 4)
        .join("\n      ")}`,
    );
    throw error;
  }
}

async function noOverflowAt320(page, label) {
  await page.setViewportSize({ width: 320, height: 800 });
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label} (320): ${scroll} > ${client}`);
  await page.setViewportSize({ width: 390, height: 844 });
}

async function shot(page, name) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

async function call(page, method, path, body) {
  return page.evaluate(
    async ({ m, p, b }) => {
      const headers = { accept: "application/json" };
      if (m !== "GET") {
        headers["content-type"] = "application/json";
        headers["x-csrf-token"] = (
          await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json()
        ).csrfToken;
      }
      const response = await fetch(p, {
        method: m,
        credentials: "same-origin",
        headers,
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      let json = null;
      try {
        json = await response.json();
      } catch {}
      return { status: response.status, body: json };
    },
    { m: method, p: path, b: body },
  );
}

async function signInAndOnboard(page, address) {
  await page.goto("/api/v1/auth/csrf", { waitUntil: "load" });
  await page.evaluate(
    async ({ address, phone }) => {
      const post = async (path, body, token) => {
        const r = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": token },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`${path} ${r.status} ${(await r.text()).slice(0, 120)}`);
        return r.json();
      };
      const token = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
        .csrfToken;
      const session = (await post("/api/v1/auth/dev/sign-in", { email: address }, token)).csrfToken;
      await post("/api/v1/onboarding/phone", { phone }, session);
      await post("/api/v1/onboarding/phone/verify", { code: "000000" }, session);
      await post("/api/v1/onboarding/birthdate", { birthdate: "1995-06-15" }, session);
      const created = await post("/api/v1/onboarding/provision", {}, session);
      await post(`/api/v1/cards/${created.card.id}/pin`, { pin: "482915" }, session);
    },
    { address, phone: phone() },
  );
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch();
const newContext = () =>
  browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", baseURL: BASE });
const adminCtx = await newContext();
const otherCtx = await newContext();
const visitorCtx = await newContext();
const admin = await adminCtx.newPage();
const other = await otherCtx.newPage();
const visitor = await visitorCtx.newPage();
for (const p of [admin, other, visitor]) p.setDefaultTimeout(30_000);

let currentFee = 5;
let newFee = 7;

try {
  await step("setup: the admin is Super Admin; a second player and a visitor exist", async () => {
    await signInAndOnboard(admin, ADMIN_EMAIL);
    await signInAndOnboard(other, email("other"));
    execSync("pnpm dev:setup", {
      cwd: REPO,
      env: { ...process.env, SUPER_ADMIN_EMAIL: ADMIN_EMAIL },
      stdio: "pipe",
    });
    // a re-run on the same database starts clean: nothing of an earlier run is still waiting
    const waiting = await call(admin, "GET", "/api/v1/admin/actions?scope=OPEN");
    for (const item of waiting.body.items) {
      await call(admin, "POST", `/api/v1/admin/actions/${item.id}/cancel`, {
        reason: "Cleaning up before a test run",
      });
    }
    const overview = await call(admin, "GET", "/api/v1/admin/config");
    assert.equal(overview.status, 200);
    currentFee = Number(overview.body.keys.find((k) => k.key === "fee_percent").current);
    newFee = currentFee === 7 ? 8 : 7;
  });

  await step(
    "Configuration lists the allow-listed settings with current value, default and bounds",
    async () => {
      await admin.goto("/console/configuration");
      await admin.getByRole("heading", { level: 1, name: "Configuration" }).waitFor();
      const settings = admin.getByRole("list", { name: "Settings" });
      for (const label of [
        "Marketplace fee",
        "Standard delivery fee",
        "Express delivery fee",
        "Zap delivery fee",
      ]) {
        await settings.getByRole("article", { name: label }).waitFor();
      }
      const fee = settings.getByRole("article", { name: "Marketplace fee" });
      await fee.getByText(`${currentFee}%`, { exact: true }).first().waitFor();
      await fee.getByText("0% to 20%", { exact: true }).waitFor();
      await admin.getByText(/waits 24 h 0 min before it is applied/).waitFor();
      await shot(admin, "admin-actions-01-configuration");
    },
  );

  await step(
    "the form refuses a short reason and an out-of-range value, then proposes the change",
    async () => {
      const form = admin.getByRole("form", { name: "Change Marketplace fee" });
      await form.getByRole("button", { name: /^Propose change/ }).click();
      await form.getByText("Enter whole percent from 0% to 20%.").waitFor();
      await form.getByText("Give a reason of at least 5 characters.").waitFor();
      await form.getByLabel(/^New value/).fill("99");
      await form.getByLabel(/^Reason/).fill(REASON);
      await form.getByRole("button", { name: /^Propose change/ }).click();
      await form.getByText("Enter whole percent from 0% to 20%.").waitFor();
      await form.getByLabel(/^New value/).fill(String(newFee));
      await form.getByRole("button", { name: /^Propose change/ }).click();
      await admin.getByText(`Proposed: set Marketplace fee to ${newFee}%.`).first().waitFor();
      const settings = admin.getByRole("list", { name: "Settings" });
      await settings.getByRole("article", { name: "Marketplace fee" }).getByText("Change waiting").waitFor();
      // nothing changed yet
      await settings
        .getByRole("article", { name: "Marketplace fee" })
        .getByText(`${currentFee}%`, { exact: true })
        .first()
        .waitFor();
      await shot(admin, "admin-actions-02-proposed");
    },
  );

  await step(
    "Pending actions shows it waiting with a countdown; cancelling needs a reason and moves it to History",
    async () => {
      await admin.goto("/console/actions");
      await admin.getByRole("heading", { level: 1, name: "Pending actions" }).waitFor();
      const card = admin.getByRole("article", { name: `Set Marketplace fee to ${newFee}%` });
      await card.waitFor();
      await card.getByText(/Applies in 2[34] h \d+ min/).waitFor();
      await card.getByText(`Why: ${REASON}`).waitFor();
      await shot(admin, "admin-actions-03-waiting");
      await card.getByRole("button", { name: /^Cancel this change/ }).click();
      await card.getByText("Give a reason of at least 5 characters.").waitFor();
      await card.getByLabel(/^Reason/).fill("Changed my mind about the fee");
      await card.getByRole("button", { name: /^Cancel this change/ }).click();
      await admin.getByText(`Cancelled: Set Marketplace fee to ${newFee}%.`).first().waitFor();
      await admin.getByText("Nothing is waiting").waitFor();
      const history = admin.getByRole("region", { name: "Delayed actions: applied, cancelled or failed" });
      await history.getByText("Cancelled", { exact: true }).first().waitFor();
      await history.getByText("Cancelled: Changed my mind about the fee").first().waitFor();
      await noOverflowAt320(admin, "/console/actions");
      await shot(admin, "admin-actions-04-cancelled");
    },
  );

  await step(
    "proposing again, then the owner-only helper makes it due and the jobs run applies it exactly once",
    async () => {
      const proposed = await call(admin, "POST", "/api/v1/admin/config", {
        key: "fee_percent",
        value: String(newFee),
        reason: REASON,
      });
      assert.equal(proposed.status, 201);
      assert.equal(proposed.body.action.state, "QUEUED");
      // not due: nothing is applied however often the jobs run
      const still = await call(admin, "GET", "/api/v1/admin/actions?scope=OPEN");
      assert.equal(still.body.items.length, 1);
      const appliedBefore = (
        await call(admin, "GET", "/api/v1/admin/actions?scope=HISTORY")
      ).body.items.filter((i) => i.state === "EXECUTED").length;
      execSync("pnpm dev:expedite-admin-actions", {
        cwd: REPO,
        env: { ...process.env, BASE_URL: BASE },
        stdio: "pipe",
      });
      execSync("pnpm dev:expedite-admin-actions", {
        cwd: REPO,
        env: { ...process.env, BASE_URL: BASE },
        stdio: "pipe",
      });
      await admin.goto("/console/actions");
      await admin.getByRole("heading", { level: 1, name: "Pending actions" }).waitFor();
      await admin.getByText("Nothing is waiting").waitFor();
      const history = admin.getByRole("region", { name: "Delayed actions: applied, cancelled or failed" });
      await history.getByText("Applied", { exact: true }).first().waitFor();
      const applied = await call(admin, "GET", "/api/v1/admin/actions?scope=HISTORY");
      assert.equal(
        applied.body.items.filter((i) => i.state === "EXECUTED").length,
        appliedBefore + 1,
        "applied exactly once, however many times the jobs ran",
      );
      await shot(admin, "admin-actions-05-applied");
      await admin.goto("/console/configuration");
      await admin.getByRole("heading", { level: 1, name: "Configuration" }).waitFor();
      await admin
        .getByRole("article", { name: "Marketplace fee" })
        .getByText(`${newFee}%`, { exact: true })
        .first()
        .waitFor();
    },
  );

  await step(
    "the storefront announces the change to a visitor; the public answer names no person or reason",
    async () => {
      await visitor.goto("/");
      const banner = visitor.getByText("Store news");
      await banner.waitFor();
      await visitor.getByText(`The marketplace fee is now ${newFee}% on new orders.`).first().waitFor();
      await visitor.getByText("Orders you have already placed keep the price they were placed at.").waitFor();
      await shot(visitor, "admin-actions-06-banner");
      await noOverflowAt320(visitor, "/ with the banner");
      const res = await fetch(`${BASE}/api/v1/announcements`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("cache-control") ?? "", /^public, s-maxage=30$/);
      const text = await res.text();
      for (const secret of [REASON, ADMIN_EMAIL, "reason", "requested"])
        assert.ok(!text.includes(secret), `the public answer carries "${secret}"`);
      assert.deepEqual(Object.keys(JSON.parse(text).items[0]).sort(), [
        "announcedAt",
        "effectiveFrom",
        "id",
        "key",
        "value",
      ]);
    },
  );

  await step("a non-admin and a visitor see only 'Not available'; the API refuses them", async () => {
    for (const [who, page] of [
      ["player", other],
      ["visitor", visitor],
    ]) {
      for (const path of ["/console/actions", "/console/configuration"]) {
        await page.goto(path);
        await page.getByRole("heading", { level: 1, name: "Not available" }).waitFor();
        const body = await page.evaluate(() => document.body.innerText);
        assert.ok(
          !/Pending actions|Configuration|Commerce Console/i.test(body ?? ""),
          `${who}: ${path} hints at what exists`,
        );
      }
    }
    const refused = await call(other, "POST", "/api/v1/admin/config", {
      key: "fee_percent",
      value: "9",
      reason: REASON,
    });
    assert.equal(refused.status, 403);
    const anonymous = await call(visitor, "GET", "/api/v1/admin/actions");
    assert.equal(anonymous.status, 401);
  });
} catch {
  process.exitCode = 1;
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed} of ${results.length} steps passed${failed ? `, ${failed} failed` : ""}`,
  );
  console.log("Screenshots:");
  for (const path of shots) console.log(`  ${path}`);
}
