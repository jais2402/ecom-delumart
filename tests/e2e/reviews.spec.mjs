// Ratings and reviews end to end against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/reviews.spec.mjs            (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner.
// Signed out: the section and its empty or summary state, no "Write a review" -> sign in and
// onboard -> buy a product from the balance -> "Write a review" -> a link in the text is refused
// inline -> post -> public once the purchase minute has ended -> stars, Verified owner, the day ->
// edit (Edited) -> keyboard rating -> delete -> no personal data in public answers, no overflow.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-reviews-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const PIN = "482915";
const CODE = "000000";
const run = Math.random().toString(36).slice(2, 10);
const EMAIL = `reviews-${run}@example.com`;
const PHONE = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const TITLE = `Mostly moon ${run}`;

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

/** A same-origin API call from the page (with the CSRF token for writes), as the app's api() does. */
async function call(page, method, path, body, key) {
  return page.evaluate(
    async ({ method, path, body, key }) => {
      const headers = { accept: "application/json" };
      if (method !== "GET") {
        const t = await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json();
        headers["x-csrf-token"] = t.csrfToken;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = crypto.randomUUID();
      const r = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        // as the app's api() does: a public answer may be cached, and this test reads its own writes
        cache: "no-store",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, cache: r.headers.get("cache-control"), body: await r.json() };
    },
    { method, path, body, key },
  );
}

const section = (page) => page.getByRole("region", { name: "Ratings and reviews" });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
  baseURL: BASE,
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

let product;

try {
  await step("pick a seed product nobody here owns yet", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    const { items } = await response.json();
    product = items.find((p) => p.available && p.sellerKey === "SEED");
    assert.ok(product, "no available seed product (run pnpm dev:setup)");
  });

  await step(
    "signed out: the product page has a Ratings and reviews section and no Write a review",
    async () => {
      await page.goto(`/p/${product.id}`);
      await page.getByRole("heading", { level: 1, name: product.name }).waitFor();
      await section(page).waitFor();
      await section(page)
        .getByRole("img", { name: /out of 5 stars|No reviews yet/ })
        .waitFor();
      assert.equal(await page.getByRole("button", { name: "Write a review" }).count(), 0);
      const pub = await call(page, "GET", `/api/v1/products/${product.id}/reviews`);
      assert.equal(pub.status, 200);
      assert.match(pub.cache ?? "", /^public/);
      await noOverflow(page, "product reviews (signed out)");
    },
  );

  await step("sign in and onboard", async () => {
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
  });

  await step("not yet an owner: no Write a review; the API says REVIEW_NOT_ALLOWED", async () => {
    await page.goto(`/p/${product.id}`);
    await section(page).waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("button", { name: "Write a review" }).count(), 0);
    const refused = await call(page, "PUT", `/api/v1/products/${product.id}/review`, { rating: 5 });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "REVIEW_NOT_ALLOWED");
  });

  await step("buy the product from the bank balance", async () => {
    const quote = await call(
      page,
      "POST",
      "/api/v1/checkout-sessions",
      { lines: [{ productId: product.id }], speedBySeller: { SEED: "STANDARD" } },
      true,
    );
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    const attempt = await call(page, "POST", `/api/v1/checkout-sessions/${quote.body.id}/attempts`, {
      method: "BALANCE",
    });
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
    const paid = await call(
      page,
      "POST",
      `/api/v1/checkout-sessions/${quote.body.id}/pay`,
      { attemptId: attempt.body.id },
      true,
    );
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
  });

  await step(
    "an owner sees Write a review; a link in the text is refused inline and not echoed",
    async () => {
      await page.goto(`/p/${product.id}`);
      await page.getByRole("button", { name: "Write a review" }).click();
      const form = page.getByRole("form", { name: "Write a review" });
      await form.getByRole("group", { name: /Your rating/ }).waitFor();
      await form.getByRole("radio", { name: "4 stars" }).check({ force: true });
      await form.getByLabel("Title (optional)").fill(TITLE);
      await form
        .getByLabel("Your review (optional)")
        .fill("Glows softly. Details at www.moon-secret.example");
      await form.getByRole("button", { name: "Post review" }).click();
      await form.getByText("Remove links and web addresses.").waitFor();
      assert.equal(
        await page.getByText("moon-secret", { exact: false }).count(),
        1,
        "only the field keeps the text",
      );
      await noOverflow(page, "review form");
      await shot(page, "reviews-01-field-error");
    },
  );

  await step("post the review; it appears once the purchase's minute has ended", async () => {
    const form = page.getByRole("form", { name: "Write a review" });
    await form.getByLabel("Your review (optional)").fill("Glows softly and naps well.");
    await form.getByRole("button", { name: "Post review" }).click();
    await section(page).getByRole("heading", { name: "Your review" }).waitFor();
    const deadline = Date.now() + 75_000;
    let found = false;
    while (!found && Date.now() < deadline) {
      const pub = await call(page, "GET", `/api/v1/products/${product.id}/reviews`);
      found = pub.body.items.some((i) => i.title === TITLE);
      if (!found) await page.waitForTimeout(3_000);
    }
    assert.ok(found, "the review never became public");
  });

  await step(
    "the public list shows stars, the title, Verified owner and the day; the summary counts it",
    async () => {
      await page.goto(`/p/${product.id}`);
      const list = section(page).getByRole("list", { name: "Reviews" });
      const item = list.getByRole("listitem").filter({ hasText: TITLE });
      await item.waitFor();
      await item.getByRole("img", { name: "Rated 4 out of 5" }).waitFor();
      await item.getByText("Verified owner").waitFor();
      assert.match(await item.innerText(), /\d{1,2} [A-Z][a-z]{2} \d{4}/);
      await section(page)
        .getByRole("img", { name: /out of 5 stars, \d+ reviews?$/ })
        .first()
        .waitFor();
      await section(page)
        .getByRole("progressbar", { name: /^4 stars: \d+/ })
        .waitFor();
      await noOverflow(page, "product reviews (owner)");
      await shot(page, "reviews-02-public");
    },
  );

  await step(
    "edit by keyboard: the radio group moves with the arrow keys; the review shows Edited",
    async () => {
      await page.getByRole("button", { name: "Edit your review" }).click();
      const form = page.getByRole("form", { name: "Edit your review" });
      const four = form.getByRole("radio", { name: "4 stars" });
      assert.ok(await four.isChecked());
      await four.focus();
      await page.keyboard.press("ArrowRight");
      assert.ok(
        await form.getByRole("radio", { name: "5 stars" }).isChecked(),
        "arrow key did not move the rating",
      );
      await form.getByRole("button", { name: "Save changes" }).click();
      await section(page).getByRole("img", { name: "You rated it 5 out of 5" }).waitFor();
      await section(page)
        .getByText(/Edited/)
        .first()
        .waitFor();
    },
  );

  await step(
    "public answers carry no email, phone or user id; your review is only in the private call",
    async () => {
      const pub = await call(page, "GET", `/api/v1/products/${product.id}/reviews`);
      const text = JSON.stringify(pub.body);
      assert.ok(!text.includes(EMAIL) && !text.includes(PHONE), "contact data in the public answer");
      assert.ok(!/userId|orderId|reviewId|eligible/.test(text), "private fields in the public answer");
      const mine = await call(page, "GET", `/api/v1/me/reviews/${product.id}`);
      assert.equal(mine.status, 200);
      assert.equal(mine.cache, "private, no-store");
      assert.equal(mine.body.review.rating, 5);
      const html = await (await fetch(`${BASE}/p/${product.id}`)).text();
      assert.ok(!html.includes(EMAIL), "the public HTML contains the email");
    },
  );

  await step("delete the review: it leaves the page", async () => {
    await page.getByRole("button", { name: "Delete your review" }).click();
    await section(page).getByText("Your review is deleted.").first().waitFor();
    const pub = await call(page, "GET", `/api/v1/products/${product.id}/reviews`);
    assert.ok(!pub.body.items.some((i) => i.title === TITLE), "the deleted review is still public");
    await page.getByRole("button", { name: "Write a review" }).waitFor();
    await noOverflow(page, "after delete");
  });
} catch {
  console.log(`\nStopped at: ${current}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${process.exitCode ? " (stopped early)" : ""}`);
  console.log(`Screenshots: ${shots.length ? shots.join(", ") : "none"}`);
}
