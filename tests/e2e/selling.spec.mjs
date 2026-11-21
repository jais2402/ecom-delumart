// End-to-end selling journey against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/selling.spec.mjs            (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner. 390px viewport.
// Fresh user onboards -> /sell shows both routes locked at ₹100 crore -> passport quiz (one wrong
// answer, then right) -> save three products -> concept with a link is refused on its field ->
// clean concept accepted -> /sell shows unlocked via the passport, balance unchanged -> shop
// registration (bad handle, then a good one) -> review shows the ₹5 lakh fee -> pay from the bank
// balance -> confirmation -> balance ₹99.95 crore -> public shop page signed out, no personal data
// in its HTML -> a second fresh user cannot take the same handle. No horizontal overflow at 320px.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-selling-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PIN = "482915";
const CODE = "000000";
const run = Math.random().toString(36).slice(2, 10);
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const EMAIL = `sell-${run}@example.com`;
const HANDLE = `shop-${run}`;
const SHOP_NAME = `Test Shop ${run}`;

// Paise: ₹100 crore at the start; the registration fee is ₹5 lakh.
const START = 100_000_000_000n;
const FEE = 50_000_000n;

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

async function getJson(page, path) {
  return page.evaluate(async (p) => {
    const response = await fetch(p, { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  }, path);
}

async function postJson(page, path, body) {
  return page.evaluate(
    async ({ p, b }) => {
      const csrf = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
        .csrfToken;
      const response = await fetch(p, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(b),
      });
      return { status: response.status, body: await response.json() };
    },
    { p: path, b: body },
  );
}

async function onboard(page, email) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /Sign in locally|Email me a sign-in link/ }).click();
  await page.waitForURL(/\/onboarding\/phone/);
  await page.getByLabel("Mobile number (India)").fill(phone());
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
}

const QUIZ = {
  right: [
    "Fictional play money with no real-world value",
    "Nothing real ships: delivery is a simulation",
    "Simulated buyers, not real players",
  ],
  wrongThird: "Real players who chose to stay anonymous",
};

const browser = await chromium.launch();
const newContext = () =>
  browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", baseURL: BASE });
const context = await newContext();
const page = await context.newPage();
page.setDefaultTimeout(20_000);

let products = [];

try {
  await step("fresh user onboards", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    products = (await response.json()).items.filter((p) => p.available).slice(0, 3);
    assert.ok(products.length >= 3, "need at least three available products (run pnpm dev:setup)");
    await onboard(page, EMAIL);
  });

  await step("/sell shows both routes locked with the ₹100 crore balance", async () => {
    await page.goto("/sell");
    await page.getByRole("heading", { level: 1, name: "Sell on DeluluMart" }).waitFor();
    const spend = page.getByRole("region", { name: /Spend down below/ });
    const passport = page.getByRole("region", { name: "Inventor Passport — free" });
    await spend.waitFor();
    await passport.waitFor();
    await spend
      .getByText(/100 crore fictional rupees/)
      .first()
      .waitFor();
    await spend.getByText(/does not count/).waitFor();
    await passport.getByText("0 of 3 steps done. Do them in any order.").waitFor();
    assert.equal(await page.getByText("Your creator studio is open.").count(), 0);
    await noOverflow(page, "/sell (390)");
    await shot(page, "selling-01-sell-locked");
  });

  await step("passport quiz: one wrong answer shows a calm retry message, then it passes", async () => {
    await page.goto("/sell/passport");
    await page.getByRole("heading", { level: 1, name: "Inventor Passport" }).waitFor();
    await page.getByRole("radio", { name: QUIZ.right[0] }).check();
    await page.getByRole("radio", { name: QUIZ.right[1] }).check();
    await page.getByRole("radio", { name: QUIZ.wrongThird }).check();
    await page.getByRole("button", { name: "Check my answers" }).click();
    await page.getByText(/as many times as you like/).waitFor();
    assert.equal(await page.getByText("Take another look at this one.").count(), 1);
    await shot(page, "selling-02-passport-in-progress");
    await page.getByRole("radio", { name: QUIZ.right[2] }).check();
    await page.getByRole("button", { name: "Check my answers" }).click();
    await page.getByText("You passed the quiz.").waitFor();
  });

  await step("save three products from the catalog (heart toggles, announced)", async () => {
    for (const product of products) {
      await page.goto(`/p/${product.id}`);
      await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
      await page.getByRole("button", { name: `Save ${product.name}` }).click();
      await page.getByRole("button", { name: `Remove ${product.name} from saved` }).waitFor();
    }
    await page.goto("/account/saved");
    await page.getByRole("heading", { level: 1, name: "Saved products" }).waitFor();
    for (const product of products) {
      await page.getByRole("button", { name: `Remove ${product.name} from saved` }).waitFor();
    }
    await page.goto("/sell/passport");
    await page.getByText(/3 of 3 saved/).waitFor();
  });

  await step("a concept with a link is refused with a field message that does not echo it", async () => {
    const field = page.getByRole("textbox", { name: "Your invention concept" });
    await field.fill("A teapot that pours any weather. See http://example.com for the plans.");
    await page.getByRole("button", { name: "Save my concept" }).click();
    await page.getByText(/Remove web links and site names/).waitFor();
    assert.equal(await page.getByText("example.com").count(), 1, "only the textarea may hold the text");
    await shot(page, "selling-03-concept-error");
  });

  await step("a clean concept is accepted and sends you to /sell, unlocked via the passport", async () => {
    await page
      .getByRole("textbox", { name: "Your invention concept" })
      .fill("A teapot that pours any weather you ask for.");
    await page.getByRole("button", { name: "Save my concept" }).click();
    await page.waitForURL(/\/sell\/?$/);
    await page.getByText("Your creator studio is open.").waitFor();
    await page.getByText("Keep shopping or build something impossible.").waitFor();
    await page.getByText("You unlocked it with the Inventor Passport.").waitFor();
    await page
      .getByRole("region", { name: "Inventor Passport — free" })
      .getByText("Unlocked this way")
      .waitFor();
    // a spend-down threshold was not crossed: the balance is untouched
    const wallet = await getJson(page, "/api/v1/wallet");
    assert.equal(BigInt(wallet.body.balancePaise), START);
    await page.getByRole("link", { name: "Register a shop" }).first().waitFor();
    await shot(page, "selling-04-sell-unlocked");
  });

  await step("the celebration is one-time: a reload does not show it again", async () => {
    await page.reload();
    await page.getByRole("heading", { level: 1, name: "Sell on DeluluMart" }).waitFor();
    await page.getByRole("link", { name: "Register a shop" }).first().waitFor();
    assert.equal(await page.getByText("Your creator studio is open.").count(), 0);
  });

  await step("no horizontal overflow at 320px on /sell, /sell/passport, /sell/register", async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const path of ["/sell", "/sell/passport", "/sell/register"]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await noOverflow(page, `${path} (320)`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await step("register: a handle with a bad format is refused on the field, live", async () => {
    await page.goto("/sell/register");
    await page.getByRole("heading", { level: 1, name: "Register your shop" }).waitFor();
    const handle = page.getByRole("textbox", { name: /Shop handle/ });
    await handle.fill("Bad_Handle");
    await page.getByText("Use lowercase letters only.").waitFor();
    await page.getByRole("textbox", { name: /Display name/ }).fill(SHOP_NAME);
    await page.getByRole("button", { name: "Review the fee" }).click();
    assert.equal(await page.getByText("Company registration · virtual fee").count(), 0, "must not advance");
    await handle.fill("-bad-");
    await page.getByText("Do not start or end with a hyphen.").waitFor();
  });

  await step("register: a valid unique handle shows the review with the ₹5 lakh fee", async () => {
    const handle = page.getByRole("textbox", { name: /Shop handle/ });
    await handle.fill(HANDLE);
    await page.getByText(`/store/${HANDLE}`).first().waitFor();
    await page.getByRole("button", { name: "Review the fee" }).click();
    await page.getByRole("heading", { name: "Company registration · virtual fee" }).waitFor();
    const review = page.getByRole("region", { name: "Company registration review" });
    await review
      .getByText(/5 lakh fictional rupees/)
      .first()
      .waitFor();
    await review
      .getByText("This is a one-time setup fee, not a product purchase.", { exact: false })
      .waitFor();
    await review.getByText(/held for you for five minutes/).waitFor();
    await noOverflow(page, "registration review");
    await shot(page, "selling-05-registration-review");
  });

  await step(
    "pay with the bank balance: confirmation shows the shop, 0 of 100 used and a receipt",
    async () => {
      await page.getByRole("radio", { name: /Bank balance/ }).check();
      await page.getByRole("button", { name: "Pay the setup fee" }).click();
      await page.getByRole("heading", { level: 1, name: "Your shop is open" }).waitFor();
      await page.getByText(SHOP_NAME).first().waitFor();
      await page.getByText("0 of 100 used").waitFor();
      await page.getByText(/Receipt: setup fee/).waitFor();
      await page.getByRole("link", { name: "Create your first listing" }).waitFor();
      await page.getByRole("link", { name: "View your shop page" }).waitFor();
      await noOverflow(page, "registration confirmation");
      await shot(page, "selling-06-confirmation");
    },
  );

  await step("balance is now ₹99.95 crore", async () => {
    const wallet = await getJson(page, "/api/v1/wallet");
    assert.equal(BigInt(wallet.body.balancePaise), START - FEE);
    await page.goto("/account");
    await page.getByRole("heading", { level: 1, name: "Your account" }).waitFor();
    await page
      .getByText(/99 crore 95 lakh|99\.95 crore/)
      .first()
      .waitFor();
    await page.getByRole("link", { name: "Open your shop" }).waitFor();
  });

  await step("owner's shop home shows tier, warehouse and the honest empty state", async () => {
    await page.goto("/sell/shop");
    await page.getByRole("heading", { level: 1, name: SHOP_NAME }).waitFor();
    await page.getByText("Solo shop").waitFor();
    await page.getByText("0 of 100 used").first().waitFor();
    await page.getByText("No player purchases yet.").waitFor();
    await page.getByText("Create a listing to start selling.").waitFor();
    await noOverflow(page, "/sell/shop");
  });

  await step(`/store/${HANDLE} loads signed out and its HTML has no balance or email`, async () => {
    const anon = await newContext();
    const anonPage = await anon.newPage();
    anonPage.setDefaultTimeout(20_000);
    const response = await anon.request.get(`${BASE}/store/${HANDLE}`);
    assert.equal(response.status(), 200);
    const html = await response.text();
    assert.ok(html.includes(SHOP_NAME), "the shop name is in the page");
    assert.ok(!html.includes(EMAIL), "the owner's email is in the HTML");
    assert.ok(!/example\.com/i.test(html), "an email domain is in the HTML");
    // the site-wide meta description mentions the ₹100 crore starting grant; no person's balance appears
    assert.ok(!/balancePaise\\?":\\?"\d/.test(html), "a balance figure is in the HTML");
    assert.ok(!/your balance|balance:/i.test(html), "a balance label is in the HTML");
    assert.ok(
      !/private, no-store/i.test(response.headers()["cache-control"] ?? ""),
      "public page sent as private",
    );
    await anonPage.goto(`/store/${HANDLE}`);
    await anonPage.getByRole("heading", { level: 1, name: SHOP_NAME }).waitFor();
    await anonPage.getByText("No products yet").first().waitFor();
    await noOverflow(anonPage, "/store/<handle>");
    await shot(anonPage, "selling-07-public-shop");
    const missing = await anon.request.get(`${BASE}/store/no-such-shop-${run}`);
    assert.equal(missing.status(), 404);
    await anon.close();
  });

  await step("a second fresh user sees the same handle is taken", async () => {
    const other = await newContext();
    const otherPage = await other.newPage();
    otherPage.setDefaultTimeout(20_000);
    await onboard(otherPage, `sell2-${run}@example.com`);
    // unlock through the API (the first user's journey already covered the passport screens)
    const passport = (await getJson(otherPage, "/api/v1/passport")).body;
    const answers = {
      "q-money": "opt-money-play",
      "q-delivery": "opt-delivery-sim",
      "q-buyers": "opt-buyers-sim",
    };
    assert.equal(passport.quiz.questions.length, 3);
    assert.equal((await postJson(otherPage, "/api/v1/passport/quiz", { answers })).body.passed, true);
    for (const product of (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items.slice(0, 3)) {
      assert.equal((await postJson(otherPage, "/api/v1/saves", { productId: product.id })).status, 200);
    }
    const concept = await postJson(otherPage, "/api/v1/passport/concept", {
      concept: "A lamp that glows with last night's dreams.",
    });
    assert.equal(concept.status, 200);
    await otherPage.goto("/sell/register");
    await otherPage.getByRole("heading", { level: 1, name: "Register your shop" }).waitFor();
    await otherPage.getByRole("textbox", { name: /Shop handle/ }).fill(HANDLE);
    await otherPage.getByRole("textbox", { name: /Display name/ }).fill(`Another Shop ${run}`);
    await otherPage.getByRole("button", { name: "Review the fee" }).click();
    await otherPage.getByText("That handle is taken. Try another.").waitFor();
    assert.equal(await otherPage.getByText("Company registration · virtual fee").count(), 0);
    await other.close();
  });
} catch {
  console.log(`\nStopped at: ${current}`);
  await page.screenshot({ path: join(SHOTS, "selling-failure.png"), fullPage: true }).catch(() => {});
  console.log(`Failure screenshot: ${join(SHOTS, "selling-failure.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${process.exitCode ? " (stopped early)" : ""}`);
  console.log("Screenshots:");
  for (const path of shots) console.log(`  ${path}`);
}
