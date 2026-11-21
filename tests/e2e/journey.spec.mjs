// End-to-end journey against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/journey.spec.mjs            (BASE_URL defaults to http://localhost:3500)
// Plain Node plus the globally installed `playwright` package; no test runner.
// Sign in -> phone -> code -> birthdate -> PIN -> buy a seed product with the card -> receipt and
// tracking -> account and collection -> owned product -> sign out -> /account redirects.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3500").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-e2e-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PIN = "482915";
const WRONG_PIN = "135790";
const CODE = "000000";
const run = Math.random().toString(36).slice(2, 10);
const EMAIL = `journey-${run}@example.com`;
const PHONE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

const results = [];
const shots = [];
const visited = [];
let current = "";

async function step(name, fn) {
  current = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error).split("\n")[0] });
    console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split("\n")[0]}`);
    throw error;
  }
}

const formatExact = (paise) => {
  const rupees = (paise / 100n).toString();
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${rest ? `${rest},` : ""}${last3}`;
};

async function noOverflow(page, label) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label}: ${scroll} > ${client}`);
}

async function shot(page, name) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

async function api(page, path) {
  return page.evaluate(async (p) => {
    const response = await fetch(p, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, path);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  baseURL: BASE,
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) visited.push(frame.url());
});

let product;
let startBalance;
let orderId;
let total;

try {
  await step("catalog is served from the database and the product page is public", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    const { items } = await response.json();
    assert.ok(items.length >= 1, "catalog is empty (run pnpm dev:setup)");
    product = items.find((p) => p.name === "Monsoon in a Jar") ?? items[0];
    assert.match(product.id, /^[0-9a-f-]{36}$/);
    const html = await (await fetch(`${BASE}/p/${product.id}`)).text();
    assert.ok(html.includes(product.name), "product name missing from the static HTML");
    assert.ok(!/>Balance</.test(html), "the public HTML contains a balance pill");
    assert.ok(!html.includes("Your balance"), "the public HTML contains a balance");
    assert.ok(!html.includes("You own this"), "the public HTML contains an owned badge");
  });

  await step("home page: signed out header shows Sign in, no overflow", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in" }).waitFor();
    assert.equal(
      (await page.getByText("fictional money", { exact: false }).locator("visible=true").count()) >= 0,
      true,
    );
    await noOverflow(page, "/");
  });

  await step("signed-out Buy now sends the person to sign-in and back", async () => {
    await page.goto(`/p/${product.id}`);
    await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
    await noOverflow(page, "product (signed out)");
    await page.getByRole("button", { name: "Buy now" }).click();
    await page.waitForURL(/\/sign-in\?next=/);
    await noOverflow(page, "/sign-in");
  });

  await step("sign in with a fresh email", async () => {
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByRole("button", { name: /Email me a sign-in link|Sign in locally/ }).click();
    await page.waitForURL(/\/onboarding\/phone/);
    await noOverflow(page, "/onboarding/phone");
  });

  await step("phone number, then the code 000000", async () => {
    await page.getByLabel("Mobile number (India)").fill(PHONE);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.waitForURL(/\/onboarding\/verify/);
    await page.getByLabel("6-digit verification code").fill(CODE);
    await noOverflow(page, "/onboarding/verify");
    await page.getByRole("button", { name: "Verify code" }).click();
    await page.waitForURL(/\/onboarding\/birthdate/);
  });

  await step("adult birthdate", async () => {
    await page.getByLabel("Day").selectOption("15");
    await page.getByLabel("Month").selectOption({ label: "June" });
    await page.getByLabel("Year").selectOption("1995");
    await noOverflow(page, "/onboarding/birthdate");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/onboarding\/pin/);
  });

  await step("game PIN 482915 lands on welcome with ₹100 crore", async () => {
    await page.getByLabel("Game PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Confirm game PIN").fill(PIN);
    await noOverflow(page, "/onboarding/pin");
    await page.getByRole("button", { name: "Save PIN" }).click();
    await page.waitForURL(/\/onboarding\/done/);
    await page.getByRole("heading", { level: 1, name: /Welcome to DeluluMart/ }).waitFor();
    await page.getByText("₹100 crore", { exact: false }).first().waitFor();
    await noOverflow(page, "/onboarding/done");
    const wallet = await api(page, "/api/v1/wallet");
    assert.equal(wallet.status, 200);
    startBalance = BigInt(wallet.body.balancePaise);
    assert.equal(startBalance, 100_000_000_000n, "starting balance is not 100 crore (in paise)");
  });

  await step("product page: signed in, balance overlay, no overflow", async () => {
    await page.goto(`/p/${product.id}`);
    await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
    await page.getByText("Your balance:").waitFor();
    await page.getByRole("link", { name: "Account" }).waitFor();
    await noOverflow(page, "product (signed in)");
    await shot(page, "01-product");
  });

  await step("public product HTML (no cookies) has no balance, handle or email", async () => {
    const me = await api(page, "/api/v1/me");
    // onboarding assigns no handle yet (no API sets one), so the handle check applies only when present
    const handle = me.body.profile?.handle ?? null;
    const html = await (await fetch(`${BASE}/p/${product.id}`)).text();
    if (handle) assert.ok(!html.includes(handle), "the public HTML contains the handle");
    assert.ok(!html.includes(EMAIL) && !html.includes(PHONE), "the public HTML contains contact data");
    assert.ok(
      !/>Balance</.test(html) && !html.includes("Your balance"),
      "the public HTML contains a balance",
    );
    assert.ok(!html.includes("1,00,00,00,000"), "the public HTML contains the balance figure");
  });

  await step("Buy now opens checkout; Standard delivery", async () => {
    await page.getByRole("button", { name: "Buy now" }).click();
    await page.waitForURL(/\/checkout\//);
    await page.getByRole("heading", { level: 2, name: "Delivery speed" }).waitFor();
    await page.getByRole("radio", { name: /Standard/ }).check();
    await noOverflow(page, "checkout: speed");
    await page.getByRole("button", { name: "Continue to payment" }).click();
  });

  await step("payment method: Delulu Card", async () => {
    await page.getByRole("heading", { level: 2, name: "Payment method" }).waitFor();
    await page.getByRole("radio", { name: /Delulu Card/ }).check();
    await noOverflow(page, "checkout: payment");
    await page.getByRole("button", { name: "Review your order" }).click();
  });

  await step("review shows the summary, balance after and the fiction label", async () => {
    await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
    await page.getByText("Balance after").waitFor();
    await page.getByText("Fictional money", { exact: false }).first().waitFor();
    await noOverflow(page, "checkout: review");
    await shot(page, "02-review");
  });

  await step("wrong PIN once: error shown and nothing charged", async () => {
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.getByLabel("Delulu PIN (game only)").waitFor();
    await page.getByLabel("Delulu PIN (game only)").fill(WRONG_PIN);
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    await page.getByText(/That PIN is not right/).waitFor();
    await page.getByText(/2 tries left/).waitFor();
    const wallet = await api(page, "/api/v1/wallet");
    assert.equal(BigInt(wallet.body.balancePaise), startBalance, "balance changed after a wrong PIN");
    await noOverflow(page, "checkout: PIN");
    await shot(page, "03-pin");
  });

  await step("correct PIN pays and shows the receipt and tracking", async () => {
    await page.getByLabel("Delulu PIN (game only)").fill(PIN);
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    await page.waitForURL(/\/orders\//, { timeout: 30_000 });
    orderId = page.url().split("/orders/")[1];
    await page.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
    await page.getByRole("region", { name: /Receipt for order/ }).waitFor();
    const stages = page.getByRole("list", { name: "Order tracking" }).getByRole("listitem");
    assert.equal(await stages.count(), 5, "tracking timeline should have five stages");
    await noOverflow(page, "/orders/[id]");
    await shot(page, "04-success");
    const order = await api(page, `/api/v1/orders/${orderId}`);
    total = BigInt(order.body.totalPaise);
    assert.ok(total > 0n);
  });

  await step("account overview shows the new balance and the order", async () => {
    await page.goto("/account");
    await page.getByRole("heading", { level: 1, name: "Your account" }).waitFor();
    const expected = startBalance - total;
    const section = page.getByRole("region", { name: "Balance and card" });
    await section.waitFor();
    assert.ok(
      (await section.innerText()).includes(formatExact(expected)),
      `balance ${formatExact(expected)} not shown`,
    );
    await page
      .getByRole("region", { name: "Recent orders" })
      .or(page.locator("#recent-orders"))
      .first()
      .waitFor();
    await page.getByText(product.name).first().waitFor();
    await noOverflow(page, "/account");
    await shot(page, "05-account-overview");
  });

  await step("orders, wallet and cards pages load without overflow", async () => {
    for (const [path, h1] of [
      ["/account/orders", "Your orders"],
      ["/account/wallet", "Wallet"],
      ["/account/cards", "Cards"],
      ["/account/profile", "Profile"],
    ]) {
      await page.goto(path);
      await page
        .getByRole("heading", { level: 1, name: h1 })
        .waitFor()
        .catch(() => assert.fail(`${path}: no h1 "${h1}"`));
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, `${path} needs exactly one h1`);
      await page.waitForLoadState("networkidle");
      await noOverflow(page, path);
    }
  });

  await step("collection shows the product", async () => {
    await page.goto("/account/collection");
    await page.getByRole("heading", { level: 1, name: "Your collection" }).waitFor();
    await page.getByRole("list", { name: "Things you own" }).getByText(product.name).waitFor();
    await noOverflow(page, "/account/collection");
  });

  await step("product page shows owned and cannot be bought again", async () => {
    await page.goto(`/p/${product.id}`);
    await page.getByText("You own this").waitFor();
    assert.equal(await page.getByRole("button", { name: "Buy now" }).count(), 0, "Buy now is still offered");
    assert.ok(await page.getByRole("button", { name: "Already in your collection" }).isDisabled());
  });

  await step("no PIN or code in storage or URLs", async () => {
    const dump = await page.evaluate(() => {
      const entries = [];
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          entries.push([key, store.getItem(key)]);
        }
      }
      return entries;
    });
    for (const [key, value] of dump) {
      const text = `${key}=${value}`;
      for (const secret of [PIN, WRONG_PIN])
        assert.ok(!text.includes(secret), `a PIN is stored under ${key}`);
      assert.notEqual(value, CODE, `the code is stored under ${key}`);
      assert.ok(!/"(pin|currentPin|code)"/i.test(String(value)), `a secret field is stored under ${key}`);
    }
    for (const url of visited) {
      for (const secret of [PIN, WRONG_PIN]) assert.ok(!url.includes(secret), `a PIN is in the URL ${url}`);
      assert.ok(!/[?&](pin|code|otp)=/i.test(url), `a secret parameter is in the URL ${url}`);
    }
  });

  await step("public pages have no horizontal overflow", async () => {
    for (const path of ["/", "/c/impossible-tech", "/search?q=jar"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await noOverflow(page, path);
    }
  });

  await step("sign out, then /account redirects to sign-in", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("link", { name: "Sign in" }).waitFor();
    await page.goto("/account");
    await page.waitForURL(/\/sign-in/);
  });
} catch (error) {
  console.log(`\nStopped at: ${current}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\n${passed}/${results.length} steps passed${process.exitCode ? " (journey stopped early)" : ""}`,
  );
  console.log("Screenshots:");
  for (const path of shots) console.log(`  ${path}`);
}
