// End-to-end sale price and free delivery journey against a running dev server (AUTH_PROVIDER=dev):
//   DEV_DB_NAME=delulu_dev node tests/e2e/sale.spec.mjs     (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner. 390px viewport.
// Seller S (shop opened through the API, one published ₹5,000 listing offering free Standard
// delivery). The listing's price history is moved back a day as the database owner (there is no
// route for it, like `pnpm dev:age-reviews`). In the portal's Pricing page S starts a ₹4,000 sale
// asking for the "Was" price and reads the price history; the public product page shows ₹4,000 with
// ₹5,000 crossed out. Buyer B pays ₹4,000 and no delivery fee. S's Earnings show gross, discount,
// fee, the delivery S paid and net, once each; the order's net equals gross - fee - delivery. S ends
// the sale (list price back, no "Was") and a new sale asking for a "Was" price is refused with
// nothing changed. S's Shipping page switches free delivery off and B's quote charges the fee again.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DB_NAME = process.env.DEV_DB_NAME ?? "delulu_dev";
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-sale-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const letters = (n) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const tag = letters(8);
const phone = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const email = (who) => `${who}-${tag}@example.com`;
const HANDLE = `shop${tag}`;
const SHOP_NAME = `Shop ${tag}`;
const NAME = `Pocket Thundercloud ${letters(6)}`;
const DESC = "A small friendly cloud that follows you around and rains only on bad news.";

const results = [];
const shots = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    for (const [who, p] of Object.entries({ seller, buyer, buyer2, visitor })) {
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

async function noOverflow(page, label) {
  await page.setViewportSize({ width: 320, height: 800 });
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label}: ${scroll} > ${client}`);
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

async function openShop(page, products) {
  await call(page, "POST", "/api/v1/passport/quiz", {
    answers: { "q-money": "opt-money-play", "q-delivery": "opt-delivery-sim", "q-buyers": "opt-buyers-sim" },
  });
  for (const p of products.slice(0, 3)) await call(page, "POST", "/api/v1/saves", { productId: p.id });
  await call(page, "POST", "/api/v1/passport/concept", {
    concept: "A kettle that boils moonlight into tea.",
  });
  const quote = await call(page, "POST", "/api/v1/company/quote", {
    handle: HANDLE,
    displayName: SHOP_NAME,
    description: "A shop made by the sale journey test.",
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const attempt = await call(page, "POST", `/api/v1/checkout-sessions/${quote.body.sessionId}/attempts`, {
    method: "BALANCE",
  });
  assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
  const paid = await page.evaluate(
    async ({ sessionId, attemptId }) => {
      const token = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
        .csrfToken;
      const r = await fetch("/api/v1/company/register", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": token,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ sessionId, attemptId }),
      });
      return { status: r.status, body: await r.json() };
    },
    { sessionId: quote.body.sessionId, attemptId: attempt.body.id },
  );
  assert.ok(paid.status < 300, JSON.stringify(paid.body));
}

async function payFromBalance(page) {
  await page.waitForURL(/\/checkout\//);
  const cont = page.getByRole("button", { name: "Continue to payment" });
  if (
    await cont.waitFor({ timeout: 4_000 }).then(
      () => true,
      () => false,
    )
  )
    await cont.click();
  await page.getByRole("heading", { level: 2, name: "Payment method" }).waitFor();
  await page.getByRole("radio", { name: /Bank balance/ }).check();
  await page.getByRole("button", { name: "Review your order" }).click();
  await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
  await page.getByRole("button", { name: "Pay now" }).click();
  await page.waitForURL(/\/orders\//, { timeout: 30_000 });
  await page.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
}

function inr(paise) {
  const p = BigInt(paise);
  let whole = (p / 100n).toString();
  if (whole.length > 3)
    whole = `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
  return `₹${whole}${p % 100n === 0n ? "" : `.${String(p % 100n).padStart(2, "0")}`}`;
}

async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Price history never changes through the app; the journey moves it as the database owner (local database only). */
function ageHistory(productId, interval) {
  const url = `postgres://postgres:postgres@127.0.0.1:5432/${DB_NAME}`;
  execSync(
    `psql "${url}" -v ON_ERROR_STOP=1 -c "BEGIN; SET LOCAL session_replication_role = replica; UPDATE core.price_history SET changed_at = changed_at - interval '${interval}' WHERE product_id = '${productId}'; COMMIT;"`,
    { stdio: "pipe" },
  );
}

async function quote(page, productId, sellerKey) {
  return page.evaluate(
    async ({ productId, sellerKey }) => {
      const token = (await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json())
        .csrfToken;
      const r = await fetch("/api/v1/checkout-sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": token,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ lines: [{ productId }], speedBySeller: { [sellerKey]: "STANDARD" } }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { productId, sellerKey },
  );
}

const browser = await chromium.launch();
const newContext = () =>
  browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", baseURL: BASE });
const seller = await (await newContext()).newPage();
const buyer = await (await newContext()).newPage();
const buyer2 = await (await newContext()).newPage();
const visitor = await (await newContext()).newPage();
for (const p of [seller, buyer, buyer2, visitor]) p.setDefaultTimeout(30_000);

let productId;
let companyId;
let order;

try {
  await step("setup: S has a shop and a ₹5,000 listing with free Standard delivery; B signs up", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    const catalog = (await response.json()).items.filter((p) => p.available && p.sellerKey === "SEED");
    assert.ok(catalog.length >= 4, "need platform products (run pnpm dev:setup)");
    await signInAndOnboard(seller, email("seller"));
    await openShop(seller, catalog);
    const created = await call(seller, "POST", "/api/v1/studio/products", {
      category: "impossible-tech",
      templateId: 120,
      altText: "A drawing of the product",
      priceRupees: 5000,
      inventoryMode: "STANDARD_STOCKED",
      quantity: 5,
      name: NAME,
      description: DESC,
      freeStandardDelivery: true,
    });
    assert.ok(created.status < 300, JSON.stringify(created.body));
    productId = created.body.product.id;
    const submitted = await call(seller, "POST", `/api/v1/studio/products/${productId}/submit`, {});
    assert.ok(submitted.status < 300, JSON.stringify(submitted.body));
    await until(
      async () =>
        (await call(seller, "GET", `/api/v1/studio/products/${productId}`)).body.product.status ===
        "PUBLISHED",
      "the listing to be published (are DATABASE_URL_JOBS and JOBS_SIGNING_KEY in apps/web/.env.local?)",
      60_000,
    );
    const listed = (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items.find(
      (p) => p.id === productId,
    );
    companyId = listed.sellerKey;
    await signInAndOnboard(buyer, email("buyer"));
  });

  await step(
    "a sale asking for a Was price is refused while the price is new; the Pricing page says why",
    async () => {
      await seller.goto("/studio/pricing");
      await seller.getByRole("heading", { level: 1, name: "Pricing" }).waitFor();
      await seller.getByText("All amounts are fictional").waitFor();
      await seller.getByRole("heading", { level: 2, name: NAME }).waitFor();
      await seller.getByText(/would not show now/).waitFor();
      await seller.getByLabel(`Sale price in rupees for ${NAME}`).fill("4000");
      await seller.getByLabel(/^Only do this if the earlier price can show/).check();
      await seller.getByRole("button", { name: "Start sale" }).click();
      await seller.getByText(/cannot show as "Was"\. Nothing was changed/).waitFor();
      const page = await (await fetch(`${BASE}/api/v1/products/${productId}`)).json();
      assert.equal(page.pricePaise, "500000");
      await noOverflow(seller, "/studio/pricing");
      await shot(seller, "sale-01-refused");
    },
  );

  await step(
    "after a day at ₹5,000, S starts a ₹4,000 sale with a Was price; the history shows it",
    async () => {
      ageHistory(productId, "25 hours");
      await seller.reload();
      await seller.getByText(/can show as "Was" if you set a lower one now/).waitFor();
      await seller.getByLabel(`Sale price in rupees for ${NAME}`).fill("4000");
      await seller.getByLabel(/^Only do this if the earlier price can show/).check();
      await seller.getByRole("button", { name: "Start sale" }).click();
      await seller.getByText("Sale started. Shoppers see it now.").waitFor();
      assert.ok((await seller.getByTestId("was-price").textContent()).includes("₹5,000"));
      await seller.getByRole("button", { name: "Change sale price" }).waitFor();
      const table = seller.getByRole("table", { name: `Price history of ${NAME}` });
      await table.getByRole("row", { name: /Sale started/ }).waitFor();
      await table.getByRole("row", { name: /Published/ }).waitFor();
      await shot(seller, "sale-02-on-sale");
    },
  );

  await step(
    "the public product page shows ₹4,000 with ₹5,000 crossed out as Was, for a signed-out visitor too",
    async () => {
      await visitor.goto(`/p/${productId}`);
      await visitor.getByRole("heading", { level: 1, name: NAME }).waitFor();
      await visitor.getByText("On sale").first().waitFor();
      const text = await visitor.locator("main").textContent();
      assert.ok(text.includes("₹4,000") && text.includes("₹5,000"), text.slice(0, 300));
      await visitor.getByText("Was").first().waitFor({ state: "attached" });
      const html = await (await visitor.request.get(`/p/${productId}`)).text();
      assert.ok(!/listPaise|salePaise|canShowReference/.test(html), "the public page carries sale internals");
      await shot(visitor, "sale-03-public");
    },
  );

  await step("B pays ₹4,000 and no delivery fee (free Standard delivery, paid by S)", async () => {
    const q = await quote(buyer, productId, companyId);
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.equal(q.body.totalPaise, "400000");
    await buyer.goto(`/p/${productId}`);
    await buyer.getByRole("heading", { level: 1, name: NAME }).waitFor();
    await buyer.getByRole("button", { name: /^Add to cart/ }).click();
    await buyer.goto("/cart");
    await buyer.locator('button[aria-label^="Remove "]').first().waitFor();
    await buyer.waitForFunction(
      () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
    );
    await buyer.getByRole("button", { name: "Check out" }).click();
    await payFromBalance(buyer);
  });

  await step(
    "S's Earnings show gross, discount, fee, the delivery S paid and net, once each; net equals the ledger",
    async () => {
      let list = await call(seller, "GET", "/api/v1/studio/orders?limit=10");
      for (let i = 0; i < 15 && list.status === 200 && list.body.items.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        list = await call(seller, "GET", "/api/v1/studio/orders?limit=10");
      }
      assert.equal(list.body.items.length, 1);
      order = list.body.items[0];
      assert.equal(order.deliveryFeeBuyerPaise, "0");
      assert.equal(order.deliveryFeeSellerPaise, "100000");
      await seller.goto("/studio/earnings");
      await seller.getByRole("heading", { level: 1, name: "Earnings" }).waitFor();
      const { body } = await call(seller, "GET", "/api/v1/studio/earnings?days=7");
      const c = body.current;
      assert.deepEqual(
        [c.orders, c.grossPaise, c.discountPaise, c.feesPaise, c.merchantDeliveryPaise, c.netPaise],
        [1, "400000", "0", "20000", "100000", "280000"],
      );
      assert.equal(
        BigInt(c.grossPaise) - BigInt(c.feesPaise) - BigInt(c.merchantDeliveryPaise),
        BigInt(c.netPaise),
      );
      const stats = seller.getByTestId("earnings-stats");
      await stats.waitFor();
      const item = (label) => stats.getByRole("listitem").filter({ hasText: label });
      for (const [label, key] of [
        ["Gross sales", "grossPaise"],
        ["Discounts you gave", "discountPaise"],
        ["Marketplace fees", "feesPaise"],
        ["Delivery you paid", "merchantDeliveryPaise"],
        ["Net earnings", "netPaise"],
      ]) {
        assert.equal(await item(label).count(), 1, `${label} is shown once`);
        assert.ok((await item(label).textContent()).includes(inr(c[key])), `${label} ${inr(c[key])}`);
      }
      await noOverflow(seller, "/studio/earnings");
      await shot(seller, "sale-04-earnings");
    },
  );

  await step(
    "S ends the sale: the list price is back and no Was price shows; asking for a Was price now is refused",
    async () => {
      await seller.goto("/studio/pricing");
      await seller.getByRole("button", { name: "End sale" }).click();
      await seller.getByText("Sale ended. The list price is back.").waitFor();
      assert.equal((await seller.getByTestId("was-price").textContent()).trim(), "Nothing");
      const page = await (await fetch(`${BASE}/api/v1/products/${productId}`)).json();
      assert.equal(page.pricePaise, "500000");
      assert.equal(page.referencePricePaise, null);
      await seller.getByLabel(`Sale price in rupees for ${NAME}`).fill("4000");
      await seller.getByLabel(/^Only do this if the earlier price can show/).check();
      await seller.getByRole("button", { name: "Start sale" }).click();
      await seller.getByText(/cannot show as "Was"\. Nothing was changed/).waitFor();
      assert.equal((await (await fetch(`${BASE}/api/v1/products/${productId}`)).json()).pricePaise, "500000");
    },
  );

  await step(
    "S's Shipping page switches free Standard delivery off: B's quote charges the fee again",
    async () => {
      await seller.goto("/studio/shipping");
      await seller.getByRole("heading", { level: 1, name: "Shipping" }).waitFor();
      await seller.getByRole("heading", { level: 2, name: NAME }).waitFor();
      await seller.getByLabel(`Free Standard delivery for shoppers (${NAME})`).uncheck();
      await seller.getByRole("button", { name: "Save delivery options" }).click();
      await seller.getByText("Delivery options saved.").waitFor();
      // B already owns the listing (one ownership per product): a second buyer asks
      await signInAndOnboard(buyer2, email("buyer2"));
      const q = await quote(buyer2, productId, companyId);
      assert.equal(q.status, 201, JSON.stringify(q.body));
      assert.equal(q.body.totalPaise, "600000");
      await noOverflow(seller, "/studio/shipping");
      await shot(seller, "sale-05-shipping");
    },
  );
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
