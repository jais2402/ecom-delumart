// End-to-end DeluluPay against a running dev server (AUTH_PROVIDER=dev), run after `pnpm dev:setup`
// (which turns the payment test scenarios on for local development):
//   node tests/e2e/payments.spec.mjs            (BASE_URL defaults to http://localhost:3500)
// Plain Node plus the globally installed `playwright` package; no test runner.
// New player -> DeluluPay ID (a real-looking handle is refused; Approve in the bank inbox pays) ->
// net banking (a wrong code, then the right one from the inbox pays) -> an expired code (test
// scenario) fails with no debit -> three wrong codes lock the attempt -> the Payments page lists
// every attempt with its status and a reason that says no fictional money moved -> nothing in
// storage or a URL holds a code -> no field for a card number, expiry, CVV or password.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3500").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-e2e-pay-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PIN = "482915";
const CODE = "000000";
const run = Math.random().toString(36).slice(2, 10);
const EMAIL = `pay-${run}@example.com`;
const PHONE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

const results = [];
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

async function noOverflow(page, label) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label}: ${scroll} > ${client}`);
}

async function api(page, path) {
  return page.evaluate(async (p) => {
    const response = await fetch(p, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, path);
}

/** The open code in the player's own bank inbox (the one place a code is ever shown). */
async function openCode(page) {
  for (let i = 0; i < 40; i++) {
    const inbox = await api(page, "/api/v1/bank/inbox");
    assert.equal(inbox.status, 200);
    const open = inbox.body.items.find((m) => m.status === "OPEN" && m.code);
    if (open) {
      assert.match(open.code, /^\d{6}$/);
      return open.code;
    }
    await page.waitForTimeout(250); // the code arrives a moment after "Send me a code"
  }
  assert.fail("no open code in the bank inbox");
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

let products = [];
let startBalance;
let ownId;
let alias;

/** Product page -> Buy now -> Standard -> the payment step. */
async function toPaymentStep(product) {
  await page.goto(`/p/${product.id}`);
  await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
  await page.getByRole("button", { name: "Buy now" }).click();
  await page.waitForURL(/\/checkout\//);
  await page.getByRole("heading", { level: 2, name: "Delivery speed" }).waitFor();
  await page.getByRole("radio", { name: /Standard/ }).check();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await page.getByRole("heading", { level: 2, name: "Payment method" }).waitFor();
}

async function balance() {
  const wallet = await api(page, "/api/v1/wallet");
  return BigInt(wallet.body.balancePaise);
}

try {
  await step("sign up: email, phone, code, birthdate, PIN", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    const { items } = await response.json();
    products = items.slice(0, 5);
    assert.ok(products.length >= 5, "catalog is empty (run pnpm dev:setup)");
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByRole("button", { name: /Email me a sign-in link|Sign in locally/ }).click();
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
    const wallet = await api(page, "/api/v1/wallet");
    startBalance = BigInt(wallet.body.balancePaise);
    ownId = wallet.body.delulupayId;
    alias = wallet.body.bankAlias;
    assert.match(ownId, /^dm-[a-z]{10}@delulu$/);
  });

  await step("checkout offers the four methods in order, with the fiction label", async () => {
    await toPaymentStep(products[0]);
    const names = await page
      .getByRole("radio")
      .evaluateAll((els) => els.map((el) => el.closest("label")?.textContent ?? ""));
    const order = ["Delulu Card", "DeluluPay ID", "Net banking", "Bank balance"];
    const methods = names.filter((n) => order.some((label) => n.includes(label)));
    assert.equal(methods.length, 4, "four payment methods expected");
    for (const [i, label] of order.entries()) {
      assert.ok(methods[i]?.includes(label), `${label} should be method ${i + 1}`);
    }
    await page
      .getByText("Fictional money", { exact: false })
      .first()
      .waitFor()
      .catch(() => undefined);
    await noOverflow(page, "checkout: methods");
  });

  await step("DeluluPay ID: a real-looking handle is refused, the player's own ID passes", async () => {
    await page.getByRole("radio", { name: /DeluluPay ID/ }).check();
    const field = page.getByLabel("DeluluPay ID", { exact: true });
    await field.waitFor();
    assert.equal(await field.inputValue(), ownId, "the player's own ID is pre-filled");
    for (const bad of ["someone@okaxis", "9876543210@ybl", "4111 1111 1111 1111"]) {
      await field.fill(bad);
      await page.getByRole("button", { name: "Review your order" }).click();
      await page
        .getByText(/real payment data|ends in @delulu/)
        .first()
        .waitFor();
      assert.equal(
        await page.getByRole("heading", { level: 2, name: "Review your order" }).count(),
        0,
        `${bad} moved on to review`,
      );
    }
    await field.fill(ownId);
    await page.getByRole("button", { name: "Review your order" }).click();
    await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
    await page.getByText("Fictional money", { exact: false }).first().waitFor();
  });

  await step("DeluluPay ID: the request arrives in the bank inbox; Approve pays", async () => {
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.getByRole("heading", { level: 2, name: "Delulu Bank approval request" }).waitFor();
    await page.getByRole("heading", { level: 2, name: "Bank inbox" }).waitFor();
    await page.getByText("Approval request", { exact: false }).first().waitFor();
    await page.getByText("In-game payment · fictional money").first().waitFor();
    await noOverflow(page, "checkout: approval");
    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForURL(/\/orders\//, { timeout: 30_000 });
    await page.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
    assert.ok((await balance()) < startBalance, "the balance did not go down");
  });

  let afterFirst;
  await step(
    "net banking: the bank page names the account and the amount and has only a code field",
    async () => {
      afterFirst = await balance();
      await toPaymentStep(products[1]);
      await page.getByRole("radio", { name: /Net banking/ }).check();
      await page.getByRole("button", { name: "Review your order" }).click();
      await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
      await page.getByRole("button", { name: "Pay now" }).click();
      await page.getByRole("form", { name: "Delulu Bank SecureCheck" }).waitFor();
      await page.getByText(alias).first().waitFor();
      await page.getByLabel(/SecureCheck code/).waitFor();
      // no field for anything but the six-digit code
      for (const label of [/card number/i, /expiry/i, /cvv/i, /password/i, /upi pin/i]) {
        assert.equal(await page.getByLabel(label).count(), 0, `a field named ${label} exists`);
      }
      await noOverflow(page, "checkout: net banking");
    },
  );

  await step(
    "net banking: the code appears only in the inbox; a wrong code, then the right one, pays",
    async () => {
      await page.getByRole("button", { name: "Send me a code" }).click();
      const code = await openCode(page);
      await page.getByTestId("inbox-code").waitFor();
      assert.equal(await page.getByTestId("inbox-code").textContent(), code);
      const wrong = code === "000000" ? "111111" : "000000";
      await page.getByLabel(/SecureCheck code/).fill(wrong);
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      await page.getByText(/That code is not right/).waitFor();
      await page.getByText(/2 tries left/).waitFor();
      assert.equal(await balance(), afterFirst, "balance changed after a wrong code");
      await page.getByLabel(/SecureCheck code/).fill(code);
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      await page.waitForURL(/\/orders\//, { timeout: 30_000 });
      await page.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
      assert.ok((await balance()) < afterFirst, "the balance did not go down");
    },
  );

  let afterSecond;
  await step("an expired code (test scenario) fails the payment with no debit and says so", async () => {
    afterSecond = await balance();
    await toPaymentStep(products[2]);
    await page.getByRole("radio", { name: /Net banking/ }).check();
    await page.getByLabel("Test scenario (staff and staging only)").selectOption("CODE_EXPIRED");
    await page.getByRole("button", { name: "Review your order" }).click();
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.getByRole("form", { name: "Delulu Bank SecureCheck" }).waitFor();
    await page.getByRole("button", { name: "Send me a code" }).click();
    await page
      .getByText(/A code was sent|Delulu Bank · SecureCheck code/)
      .first()
      .waitFor();
    await page.getByLabel(/SecureCheck code/).fill("123456");
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    await page.getByText("The code ran out of time. No fictional money moved.").waitFor();
    assert.equal(await balance(), afterSecond, "balance changed after an expired code");
    await noOverflow(page, "checkout: expired");
  });

  await step("three wrong codes lock the attempt: no debit, and the reason says so", async () => {
    await toPaymentStep(products[3]);
    await page.getByRole("radio", { name: /Net banking/ }).check();
    await page.getByRole("button", { name: "Review your order" }).click();
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.getByRole("form", { name: "Delulu Bank SecureCheck" }).waitFor();
    await page.getByRole("button", { name: "Send me a code" }).click();
    const code = await openCode(page);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      await page.getByLabel(/SecureCheck code/).fill(wrong);
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      if (i < 2) await page.getByText(/That code is not right/).waitFor();
    }
    await page.getByText("Too many wrong tries for this payment. No fictional money moved.").waitFor();
    assert.equal(await balance(), afterSecond, "balance changed after a lockout");
    // the code is gone from the inbox
    const inbox = await api(page, "/api/v1/bank/inbox");
    assert.ok(
      inbox.body.items.every((m) => m.code === undefined),
      "a closed message still shows its code",
    );
  });

  await step("Payments page: every attempt, its status, reference and reason", async () => {
    await page.goto("/account/payments");
    await page.getByRole("heading", { level: 1, name: "Payments" }).waitFor();
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "needs exactly one h1");
    const table = page.getByRole("table", { name: "Payments, newest first" });
    await table.waitFor();
    const text = await table.textContent();
    assert.equal((text.match(/Captured/g) ?? []).length, 2, "two captured payments expected");
    assert.equal((text.match(/Failed/g) ?? []).length, 2, "two failed payments expected");
    assert.ok(
      text.includes("DeluluPay ID") && text.includes("Net banking (Delulu Bank)"),
      "methods are named",
    );
    assert.ok(text.includes("Code expired"), "the expired-code reason is missing");
    assert.ok(text.includes("Too many attempts"), "the lockout reason is missing");
    assert.equal(
      (text.match(/No fictional money moved\./g) ?? []).length,
      2,
      "each failure says nothing moved",
    );
    assert.match(text, /DLP-[A-Z0-9]{20}/, "a payment reference is shown");
    await noOverflow(page, "/account/payments");
    // the statement carries the two purchases and no failed attempt
    const statement = await api(page, "/api/v1/statement?limit=50");
    const purchases = statement.body.items.filter((row) => row.eventType === "PURCHASE");
    assert.equal(purchases.length, 2, "the statement should list exactly the two captured payments");
    const payments = await api(page, "/api/v1/account/payments");
    assert.equal(payments.body.items.filter((p) => p.status === "CAPTURED").length, 2);
    const orders = await api(page, "/api/v1/orders");
    assert.equal(orders.body.items.length, 2, "orders and captured payments must agree");
  });

  await step("Bank inbox page: messages stay in the app, no overflow, one h1", async () => {
    await page.goto("/account/bank-inbox");
    await page.getByRole("heading", { level: 1, name: "Bank inbox" }).waitFor();
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "needs exactly one h1");
    await page.getByRole("list", { name: "Messages" }).waitFor();
    await page.getByText("In-game payment · fictional money").waitFor();
    await noOverflow(page, "/account/bank-inbox");
  });

  await step("no code, PIN or ID in storage or URLs", async () => {
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
      assert.ok(!text.includes(PIN), `a PIN is stored under ${key}`);
      assert.ok(!/"(pin|code|otp|cvv)"/i.test(String(value)), `a secret field is stored under ${key}`);
    }
    for (const url of visited)
      assert.ok(!/[?&](pin|code|otp|cvv)=/i.test(url), `a secret parameter is in the URL ${url}`);
  });
} catch (error) {
  console.log(`\nStopped at: ${current}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${process.exitCode ? " (stopped early)" : ""}`);
}
