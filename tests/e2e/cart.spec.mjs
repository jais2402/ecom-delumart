// End-to-end multi-item cart journey against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/cart.spec.mjs            (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner.
// Signed-out visitor adds two products -> cart + "Sign in to check out" -> sign in and onboard ->
// merge keeps both -> third product -> Express where offered -> remove one -> pay from the bank
// balance -> success lists the items -> cart empty -> collection -> owned product shown as owned.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-cart-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PIN = "482915";
const CODE = "000000";
const run = Math.random().toString(36).slice(2, 10);
const EMAIL = `cart-${run}@example.com`;
const PHONE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

const results = [];
const shots = [];
let current = "";

async function step(name, fn) {
  current = name;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split("\n")[0]}`);
    throw error;
  }
}

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const localCart = (page) =>
  page.evaluate(() => {
    const entries = {};
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (store === localStorage) entries[key] = store.getItem(key);
      }
    }
    return entries;
  });

async function api(page, path) {
  return page.evaluate(async (p) => {
    const response = await fetch(p, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, path);
}

const removeButtons = (page) => page.getByRole("button", { name: /^Remove .+ from cart$/ });
const cartLink = (page) => page.getByRole("link", { name: /^Cart, \d+ items?$/ });
async function headerCount(page) {
  const label = await cartLink(page).first().getAttribute("aria-label");
  return Number(/Cart, (\d+)/.exec(label)?.[1]);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  baseURL: BASE,
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

let products = [];
let startBalance;

async function addFromProductPage(product) {
  await page.goto(`/p/${product.id}`);
  await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
  await page.getByRole("button", { name: new RegExp(`^Add to cart.*${product.name}`) }).click();
  await page.getByRole("link", { name: new RegExp(`^In cart.*${product.name}`) }).waitFor();
}

try {
  await step("catalog has enough products to fill a cart", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    const { items } = await response.json();
    // Zap-eligible products first: in the dev seed no product offers Express, and a seller only
    // offers a speed when every one of its lines does.
    const ready = items.filter((p) => p.available);
    products = [...ready.filter((p) => p.zap), ...ready.filter((p) => !p.zap)].slice(0, 6);
    assert.ok(products.length >= 4, "need at least four available products (run pnpm dev:setup)");
  });

  await step("product page shows Buy now and Add to cart side by side", async () => {
    await page.goto(`/p/${products[0].id}`);
    await page.getByRole("heading", { level: 1, name: products[0].name }).waitFor();
    await page.getByRole("button", { name: "Buy now" }).waitFor();
    await page.getByRole("button", { name: /^Add to cart/ }).waitFor();
    await noOverflow(page, "product page");
    await shot(page, "cart-01-product-two-buttons");
  });

  await step("signed out: add two products; button turns into an In cart link; header count 2", async () => {
    await addFromProductPage(products[0]);
    await addFromProductPage(products[1]);
    assert.equal(await headerCount(page), 2);
  });

  await step("signed out: localStorage holds only product ids", async () => {
    const stored = await localCart(page);
    const keys = Object.keys(stored);
    assert.equal(keys.length, 1, `expected one key, found ${keys.join(", ")}`);
    const ids = JSON.parse(stored[keys[0]]);
    assert.ok(Array.isArray(ids) && ids.length === 2);
    for (const id of ids) assert.match(id, UUID, "a stored value is not a bare product id");
    const text = JSON.stringify(stored);
    for (const p of products) assert.ok(!text.includes(p.name), "a product name is stored");
    assert.ok(!/paise|price|@/i.test(text), "something other than ids is stored");
  });

  await step(
    "signed out: /cart shows two lines and Sign in to check out; no overflow at 390 and 320",
    async () => {
      await page.goto("/cart");
      await page.getByRole("heading", { level: 1, name: "Your cart" }).waitFor();
      await removeButtons(page).first().waitFor();
      assert.equal(await removeButtons(page).count(), 2);
      for (const p of products.slice(0, 2)) await page.getByText(p.name).first().waitFor();
      await page.getByRole("link", { name: "Sign in to check out" }).waitFor();
      await page.getByText(/Totals appear after you sign in/).waitFor();
      await noOverflow(page, "/cart signed out (390)");
      await page.setViewportSize({ width: 320, height: 800 });
      await noOverflow(page, "/cart signed out (320)");
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, "cart-02-signed-out-two-items");
    },
  );

  await step("sign in with a fresh email and complete onboarding", async () => {
    await page.getByRole("link", { name: "Sign in to check out" }).click();
    await page.waitForURL(/\/sign-in/);
    await page.getByText("Local development sign-in: no email is sent.").waitFor();
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByRole("button", { name: /Sign in locally|Email me a sign-in link/ }).click();
    await page.waitForURL(/\/onboarding\/phone/);
    await page.getByLabel("Mobile number (India)").fill(PHONE);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.waitForURL(/\/onboarding\/verify/);
    await page.getByLabel("6-digit verification code").fill(CODE);
    await page.getByRole("button", { name: "Verify code" }).click();
    await page.waitForURL(/\/onboarding\/birthdate/);
    await page.getByLabel("Day").selectOption("15");
    await page.getByLabel("Month").selectOption({ label: "June" });
    await page.getByLabel("Year").selectOption("1995");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/onboarding\/pin/);
    await page.getByLabel("Game PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Confirm game PIN").fill(PIN);
    await page.getByRole("button", { name: "Save PIN" }).click();
    await page.waitForURL(/\/onboarding\/done/);
    await page.getByRole("heading", { level: 1, name: /Welcome to DeluluMart/ }).waitFor();
    startBalance = BigInt((await api(page, "/api/v1/wallet")).body.balancePaise);
  });

  await step("merge keeps both lines, clears the local copy, header shows 2", async () => {
    await page.goto("/cart");
    await page.getByRole("heading", { level: 1, name: "Your cart" }).waitFor();
    await removeButtons(page).first().waitFor();
    assert.equal(await removeButtons(page).count(), 2);
    assert.deepEqual(await localCart(page), {}, "the local cart was not cleared after the merge");
    const server = await api(page, "/api/v1/cart");
    assert.equal(server.body.lineCount, 2);
    assert.equal(await headerCount(page), 2);
    await page.getByRole("button", { name: "Check out" }).waitFor();
  });

  await step("add a third product while signed in", async () => {
    await addFromProductPage(products[2]);
    await page.goto("/cart");
    await removeButtons(page).nth(2).waitFor();
    assert.equal(await removeButtons(page).count(), 3);
    assert.equal(await headerCount(page), 3);
  });

  await step("cart shows delivery choices, summary with balance after, and no overflow at 320", async () => {
    await page
      .getByRole("group", { name: /^Delivery from / })
      .first()
      .waitFor();
    await page.getByRole("region", { name: "Order summary" }).getByText("Balance after").waitFor();
    await page.getByText("Fictional money").first().waitFor();
    await noOverflow(page, "/cart (390)");
    await page.setViewportSize({ width: 320, height: 800 });
    await noOverflow(page, "/cart (320)");
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step("coupon error is shown inline in plain words", async () => {
    await page.getByLabel("Coupon code").fill("NOSUCHCODE");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByText(/That (code is not valid|coupon)/).waitFor();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
    );
    await shot(page, "cart-03-coupon-error");
  });

  await step(
    "change a seller's delivery to Express (or Zap when Express is not offered); the total updates",
    async () => {
      const express = page.getByRole("radio", { name: /Express/ });
      const zap = page.getByRole("radio", { name: /Zap/ });
      const expressOffered = (await express.count()) > 0;
      const faster = expressOffered ? express.first() : zap.first();
      console.log(
        `      (Express offered in this data: ${expressOffered}; using ${expressOffered ? "Express" : "Zap"})`,
      );
      await faster.waitFor();
      const summary = page.getByRole("region", { name: "Order summary" });
      const before = await summary.textContent();
      await faster.check();
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
      );
      assert.ok(await faster.isChecked());
      const preview = await page.evaluate(async () => {
        const response = await fetch("/api/v1/cart/preview", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
              .csrfToken,
          },
          body: "{}",
        });
        return response.json();
      });
      assert.ok(preview.sellers.length >= 1);
      await page.waitForFunction(
        (was) => document.querySelector('[aria-label="Order summary"]')?.textContent !== was,
        before,
      );
    },
  );

  await step("remove one line; two remain; header shows 2", async () => {
    const name = await removeButtons(page).nth(2).getAttribute("aria-label");
    await removeButtons(page).nth(2).click();
    await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="Remove "]').length === 2);
    const removed = name.replace(/^Remove /, "").replace(/ from cart$/, "");
    assert.equal(await page.getByRole("button", { name }).count(), 0, `${removed} is still in the cart`);
    assert.equal(await headerCount(page), 2);
    await page.getByRole("button", { name: "Check out" }).waitFor();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
    );
    await shot(page, "cart-04-signed-in-two-items");
  });

  await step("check out with Bank balance; the review lists each seller group", async () => {
    await page.getByRole("button", { name: "Check out" }).click();
    await page.waitForURL(/\/checkout\//);
    await page.getByRole("heading", { level: 2, name: "Payment method" }).waitFor();
    await page.getByRole("radio", { name: /Bank balance/ }).check();
    await page.getByRole("button", { name: "Review your order" }).click();
    await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
    const review = page.getByRole("region", { name: "Items in this order" });
    await review.waitFor();
    await review.getByText("Order total").waitFor();
    await review.getByText("Delivery speed").first().waitFor();
    for (const p of products.slice(0, 2)) await review.getByText(p.name).first().waitFor();
    await page.getByText("Balance after").waitFor();
    await noOverflow(page, "checkout review (390)");
    await page.setViewportSize({ width: 320, height: 800 });
    await noOverflow(page, "checkout review (320)");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "cart-05-review");
  });

  let orderId;
  await step("Pay now: success page lists every item with tracking and delivery status", async () => {
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.waitForURL(/\/orders\//, { timeout: 30_000 });
    orderId = page.url().split("/orders/")[1];
    await page.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
    const receipt = page.getByRole("region", { name: /Receipt for order/ });
    await receipt.waitFor();
    for (const p of products.slice(0, 2)) await receipt.getByText(p.name).first().waitFor();
    await receipt.getByText("Paid", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("Completed").count(),
      0,
      "payment status Completed shown beside delivery",
    );
    await page
      .getByText(/^Arriving$/)
      .first()
      .waitFor();
    await page.getByRole("list", { name: "Order tracking" }).first().waitFor();
    await noOverflow(page, "/orders/[id] (390)");
    await shot(page, "cart-06-success");
    const order = await api(page, `/api/v1/orders/${orderId}`);
    const names = order.body.sellerOrders.flatMap((so) => so.lines.map((l) => l.name));
    for (const p of products.slice(0, 2))
      assert.ok(names.includes(p.name), `${p.name} missing from the order`);
    const balance = BigInt((await api(page, "/api/v1/wallet")).body.balancePaise);
    assert.equal(
      startBalance - balance,
      BigInt(order.body.totalPaise),
      "balance did not drop by the order total",
    );
  });

  await step("header cart count returns to zero and /cart is empty", async () => {
    await page.waitForFunction(() =>
      /Cart, 0 items/.test(
        document.querySelector('a[aria-label^="Cart,"]')?.getAttribute("aria-label") ?? "",
      ),
    );
    await page.goto("/cart");
    await page.getByRole("heading", { level: 2, name: "Your cart is empty" }).waitFor();
    await page.getByRole("link", { name: "Shop DeluluMart" }).waitFor();
    assert.equal(await headerCount(page), 0);
  });

  await step("both items are in the collection", async () => {
    await page.goto("/account/collection");
    const list = page.getByRole("list", { name: "Things you own" });
    await list.waitFor();
    for (const p of products.slice(0, 2)) await list.getByText(p.name).first().waitFor();
  });

  await step("trying to add an owned product shows it as owned", async () => {
    await page.goto(`/p/${products[0].id}`);
    await page.getByText("You own this").waitFor();
    const add = page.getByRole("button", { name: /^In your collection/ });
    await add.waitFor();
    assert.ok(await add.isDisabled());
    const server = await fetch(`${BASE}/api/v1/products/${products[0].id}`);
    assert.equal(server.status, 200);
    const refused = await page.evaluate(async (id) => {
      const csrf = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
        .csrfToken;
      const response = await fetch("/api/v1/cart/lines", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ productId: id }),
      });
      return { status: response.status, code: (await response.json()).error?.code };
    }, products[0].id);
    assert.deepEqual(refused, { status: 409, code: "ALREADY_OWNED" });
  });

  await step("account pages and profile have no overflow at 320", async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ["/cart", "/account/orders", "/account/profile", `/orders/${orderId}`]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await noOverflow(page, `${path} (320)`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step("profile: save a handle and a privacy switch, then reject a reserved handle", async () => {
    await page.goto("/account/profile");
    await page.getByRole("textbox", { name: "Handle", exact: true }).waitFor();
    const handle = `cart-${run}`.slice(0, 24).toLowerCase();
    await page.getByRole("textbox", { name: "Handle", exact: true }).fill(handle);
    await page.getByRole("switch", { name: "Show my collector level" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("Your profile is up to date.").waitFor();
    await page.reload();
    await page.getByRole("textbox", { name: "Handle", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Handle", exact: true }).inputValue(), handle);
    await page.getByRole("textbox", { name: "Handle", exact: true }).fill("admin");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText("That handle is not available. Try another one.").waitFor();
  });
} catch {
  console.log(`\nStopped at: ${current}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${process.exitCode ? " (stopped early)" : ""}`);
  console.log("Screenshots:");
  for (const path of shots) console.log(`  ${path}`);
}
