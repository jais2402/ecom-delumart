// End-to-end merchant and safety journey against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/merchant.spec.mjs          (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner. 390px viewport.
// Seller S (shop opened through the API, two published listings) creates a public 10% coupon and a
// private one (generated code shown) in the portal. Buyer B sees the public coupon on the store
// page, applies it in the cart and pays. S's Orders shows the order from an "Anonymous player", the
// equation adds up, Earnings (7 days) and Overview match, and a sixth active coupon is refused. B
// reports the product (case reference) and a second report is refused; B blocks S's shop (products
// vanish, purchases refused) and unblocks it. The Super Admin dismisses the report case, hides S's
// listing, S appeals (a second appeal is refused) and the admin upholds it: the listing is public
// again and S's earnings are unchanged. No horizontal overflow at 320px on the main new pages.
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
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-merchant-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

// Letters only: random digits can trip text screening.
const letters = (n) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const tag = letters(8);
const phone = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const email = (who) => `${who}-${tag}@example.com`;
const HANDLE = `shop${tag}`;
const SHOP_NAME = `Shop ${tag}`;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? email("admin");

const results = [];
const shots = [];

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    for (const [who, p] of Object.entries({ seller, buyer, admin, visitor })) {
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
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.ok(scroll <= client + 1, `horizontal overflow on ${label}: ${scroll} > ${client}`);
}

async function noOverflowAt320(page, label) {
  await page.setViewportSize({ width: 320, height: 800 });
  await noOverflow(page, `${label} (320)`);
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

// Sign in through the dev flow and finish onboarding with API calls from the page itself.
async function signInAndOnboard(page, address) {
  // a plain JSON page: no app code to reload while the sign-in calls run
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

// Passport (quiz, three saves, concept), then a shop paid from the bank balance. Returns the company id.
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
    description: "A shop made by the studio journey test.",
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
  // a single-product checkout starts with the delivery speed
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

// ---------------------------------------------------------------- merchant journey helpers

const NAME1 = `Pocket Thundercloud ${letters(6)}`;
const DESC1 = "A small friendly cloud that follows you around and rains only on bad news.";
const NAME2 = `Folding Rainbow ${letters(6)}`;
const DESC2 = "A rainbow that folds into a pocket and unfolds over any picnic you choose.";
const PUBLIC_CODE = `TEN${tag.slice(0, 5).toUpperCase()}`;

/** Indian-grouped rupees from a paise string, as the portal prints it (no paise when whole). */
function inr(paise) {
  const p = BigInt(paise);
  const negative = p < 0n;
  const abs = negative ? -p : p;
  let whole = (abs / 100n).toString();
  if (whole.length > 3)
    whole = `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
  const fraction = abs % 100n;
  return `${negative ? "−" : ""}₹${whole}${fraction === 0n ? "" : `.${String(fraction).padStart(2, "0")}`}`;
}

async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function makeListing(page, name, description, priceRupees, quantity) {
  const created = await call(page, "POST", "/api/v1/studio/products", {
    category: "impossible-tech",
    templateId: 120,
    altText: "A drawing of the product",
    priceRupees,
    inventoryMode: "STANDARD_STOCKED",
    quantity,
    name,
    description,
  });
  assert.ok(created.status < 300, JSON.stringify(created.body));
  const id = created.body.product.id;
  const submitted = await call(page, "POST", `/api/v1/studio/products/${id}/submit`, {});
  assert.ok(submitted.status < 300, JSON.stringify(submitted.body));
  await until(
    async () =>
      (await call(page, "GET", `/api/v1/studio/products/${id}`)).body.product.status === "PUBLISHED",
    `${name} to be published (are DATABASE_URL_JOBS and JOBS_SIGNING_KEY in apps/web/.env.local?)`,
    60_000,
  );
  return id;
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

async function fillCoupon(page, { percent, publicCode }) {
  await page.getByLabel(/^Percent off/).fill(String(percent));
  if (publicCode) {
    await page.getByRole("radio", { name: /^Public/ }).check();
    await page.getByLabel(/^Public code/).fill(publicCode);
  }
  await page.getByRole("button", { name: "Create coupon" }).click();
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch();
const newContext = () =>
  browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", baseURL: BASE });
const sellerCtx = await newContext();
const buyerCtx = await newContext();
const adminCtx = await newContext();
const publicCtx = await newContext();
const seller = await sellerCtx.newPage();
const buyer = await buyerCtx.newPage();
const admin = await adminCtx.newPage();
const visitor = await publicCtx.newPage();
for (const p of [seller, buyer, admin, visitor]) p.setDefaultTimeout(30_000);

let catalog = [];
let product1;
let product2;
let companyId;
let privateCode;
let order;
let earningsBefore;
let reference;

try {
  await step(
    "setup: S has a shop and two published listings; the admin is Super Admin; B signs up",
    async () => {
      const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
      assert.equal(response.status, 200);
      catalog = (await response.json()).items.filter((p) => p.available && p.sellerKey === "SEED");
      assert.ok(catalog.length >= 4, "need platform products (run pnpm dev:setup)");
      await signInAndOnboard(seller, email("seller"));
      await openShop(seller, catalog);
      product1 = await makeListing(seller, NAME1, DESC1, 2500, 5);
      product2 = await makeListing(seller, NAME2, DESC2, 900, 5);
      const listed = (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items.find(
        (p) => p.id === product1,
      );
      companyId = listed.sellerKey;
      assert.ok(companyId && companyId !== "SEED");
      await signInAndOnboard(buyer, email("buyer"));
      await signInAndOnboard(admin, ADMIN_EMAIL);
      execSync("pnpm dev:setup", {
        cwd: REPO,
        env: { ...process.env, SUPER_ADMIN_EMAIL: ADMIN_EMAIL },
        stdio: "pipe",
      });
    },
  );

  await step(
    "S creates a public 10% coupon and a private one; the private code is shown with Copy",
    async () => {
      await seller.goto("/studio/coupons");
      await seller.getByRole("heading", { level: 1, name: "Coupons" }).waitFor();
      await seller.getByText("All amounts are fictional").waitFor();
      await seller.getByText("Discounts come out of your proceeds.").waitFor();
      await seller.getByText("0 of 5 active").waitFor();
      await fillCoupon(seller, { percent: 10, publicCode: PUBLIC_CODE });
      await seller.getByText("Coupon created").waitFor();
      await seller.getByText("1 of 5 active").waitFor();
      await fillCoupon(seller, { percent: 10 });
      const box = seller.getByTestId("private-code");
      await box.waitFor();
      privateCode = (await box.locator("code").textContent()).trim();
      assert.match(privateCode, /^[A-Z0-9-]{4,}$/, `unexpected generated code ${privateCode}`);
      await box.getByRole("button", { name: /^Copy private coupon code/ }).click();
      await box.getByText(/Copied to the clipboard|selected: copy it by hand/).waitFor();
      await seller.getByText("2 of 5 active").waitFor();
      await seller
        .getByRole("row", { name: new RegExp(PUBLIC_CODE) })
        .getByText("10% off")
        .waitFor();
      await noOverflowAt320(seller, "/studio/coupons");
      await shot(seller, "merchant-04-coupons");
    },
  );

  await step(
    "B sees the public coupon on the store page (not the private one), applies it and pays",
    async () => {
      await buyer.goto(`/store/${HANDLE}`);
      const list = buyer.getByRole("list", { name: "Shop coupons" });
      await list.waitFor();
      await list.getByText(PUBLIC_CODE).waitFor();
      await list.getByText("10% off").waitFor();
      assert.equal(await list.getByText(privateCode).count(), 0, "private code is on the store page");
      const html = await (await buyer.request.get(`/store/${HANDLE}`)).text();
      assert.ok(
        !html.includes(privateCode) && !/@example\.com/.test(html),
        "public HTML leaks a private value",
      );
      await buyer.goto(`/p/${product1}`);
      await buyer.getByRole("heading", { level: 1, name: NAME1 }).waitFor();
      await buyer.getByRole("button", { name: /^Add to cart/ }).click();
      await buyer
        .getByText(/in your cart|Added/i)
        .first()
        .waitFor();
      await buyer.goto("/cart");
      await buyer.locator('button[aria-label^="Remove "]').first().waitFor();
      await buyer.getByLabel("Coupon code").fill(PUBLIC_CODE);
      await buyer.getByRole("button", { name: "Apply" }).click();
      await buyer.getByText(PUBLIC_CODE, { exact: true }).first().waitFor();
      await buyer
        .getByText(/applied/)
        .first()
        .waitFor();
      await buyer.waitForFunction(
        () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
      );
      await buyer.getByRole("button", { name: "Check out" }).click();
      await payFromBalance(buyer);
    },
  );

  await step("S's Orders lists the order from an Anonymous player; the equation adds up", async () => {
    const list = await call(seller, "GET", "/api/v1/studio/orders?limit=10");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    order = list.body.items[0];
    assert.equal(order.buyer, "Anonymous player");
    assert.equal(order.couponCode, PUBLIC_CODE);
    const gross = BigInt(order.grossPaise);
    assert.equal(gross, BigInt(order.listPaise) - BigInt(order.discountPaise));
    assert.equal(
      gross - BigInt(order.feePaise) - BigInt(order.deliveryFeeSellerPaise),
      BigInt(order.netPaise),
      "gross - fee - delivery paid by the seller is not the net",
    );
    await seller.goto("/studio/orders");
    await seller.getByRole("heading", { level: 1, name: "Orders" }).waitFor();
    await seller.getByText("All amounts are fictional").waitFor();
    const row = seller.getByRole("row", { name: new RegExp(NAME1) });
    await row.getByText("Anonymous player").waitFor();
    await row.getByText(inr(order.netPaise)).first().waitFor();
    await row.getByText("PLAYER", { exact: true }).waitFor();
    await noOverflowAt320(seller, "/studio/orders");
    await row.getByRole("link").first().click();
    await seller.waitForURL(/\/studio\/orders\/SO-[A-Z2-9]{16}$/);
    await seller.getByRole("heading", { level: 1, name: /^Order of/ }).waitFor();
    await seller.getByText("Anonymous player").first().waitFor();
    await seller.getByText(PUBLIC_CODE, { exact: true }).waitFor();
    const equationNet = await seller.getByTestId("equation-net").textContent();
    assert.ok(equationNet.includes(`equals net ${inr(order.netPaise)}`), equationNet);
    const equationGross = await seller.getByTestId("equation-gross").textContent();
    assert.ok(equationGross.includes(`equals gross ${inr(gross)}`), equationGross);
    await seller.getByRole("list", { name: "Order tracking" }).waitFor();
    if (BigInt(order.deliveryFeeBuyerPaise) > 0n) await seller.getByText(/not your revenue/).waitFor();
    await noOverflowAt320(seller, "/studio/orders/[id]");
    await shot(seller, "merchant-02-order-detail");
    assert.equal(await seller.getByText(/@example\.com/).count(), 0, "a buyer address is on the order page");
  });

  await step(
    "Earnings (7 days): one order, matching gross, fee and net; the chart table has today's row",
    async () => {
      await seller.goto("/studio/earnings");
      await seller.getByRole("heading", { level: 1, name: "Earnings" }).waitFor();
      await seller.getByText("All amounts are fictional").waitFor();
      const { body } = await call(seller, "GET", "/api/v1/studio/earnings?days=7");
      earningsBefore = body;
      assert.equal(body.current.orders, 1);
      const stats = seller.getByTestId("earnings-stats");
      const item = (label) => stats.getByRole("listitem").filter({ hasText: label });
      await item("Completed player orders").getByText("1", { exact: true }).first().waitFor();
      assert.ok((await item("Gross sales").textContent()).includes(inr(body.current.grossPaise)));
      assert.ok((await item("Marketplace fees").textContent()).includes(inr(body.current.feesPaise)));
      assert.ok((await item("Net earnings").textContent()).includes(inr(body.current.netPaise)));
      assert.ok((await item("Net earnings").textContent()).includes("No prior baseline"));
      assert.equal(body.current.grossPaise, order.grossPaise);
      assert.equal(body.current.netPaise, order.netPaise);
      assert.match(await seller.getByTestId("earnings-asof").textContent(), /Asia\/Kolkata/);
      const day = body.daily.find((d) => d.orders === 1);
      assert.ok(day, "no day with the order");
      const table = seller.getByRole("table", { name: /Daily gross and net/ });
      const dayRow = table.getByRole("row", { name: new RegExp(day.date) });
      await dayRow.waitFor();
      assert.ok((await dayRow.textContent()).includes(inr(day.grossPaise)));
      assert.ok((await dayRow.textContent()).includes(inr(day.netPaise)));
      assert.match(await seller.getByTestId("chart-summary").textContent(), /1 order/);
      await seller.getByRole("heading", { name: "Staff orders (separate)" }).waitFor();
      await seller.getByRole("heading", { name: "Top products" }).waitFor();
      await seller.getByText("Net earnings are not your bank balance").waitFor();
      await seller.getByRole("link", { name: "wallet statement" }).waitFor();
      await seller.getByLabel("Period").selectOption("30");
      await seller.getByText(/Last 30 days compared with the 30 before/).waitFor();
      await seller.getByLabel("Period").selectOption("7");
      await seller.getByText(/Last 7 days compared with the 7 before/).waitFor();
      await noOverflowAt320(seller, "/studio/earnings");
      await shot(seller, "merchant-03-earnings");
    },
  );

  await step("Overview: the four stat cards match, brand progress and the action list show", async () => {
    await seller.goto("/studio");
    await seller.waitForURL(/\/studio\/overview/);
    await seller.getByRole("heading", { level: 1, name: "Overview" }).waitFor();
    await seller.getByText("All amounts are fictional").waitFor();
    const stats = seller.getByTestId("overview-stats");
    await stats.waitFor();
    const text = await stats.textContent();
    for (const v of [inr(order.grossPaise), inr(order.feePaise), inr(order.netPaise)])
      assert.ok(text.includes(v), `${v} missing from the overview cards`);
    assert.equal(await stats.getByRole("listitem").count(), 4);
    assert.ok(text.includes("No prior baseline"));
    await seller.getByText(/of ₹10 crore eligible player revenue/).waitFor();
    await seller.getByText(/of 5 eligible buyers/).waitFor();
    await seller.getByText("Locked", { exact: true }).waitFor();
    await seller.getByText(/Team features come later/).waitFor();
    await seller.getByRole("heading", { name: "Needs your attention" }).waitFor();
    const nav = seller.getByRole("navigation", { name: "Partner Portal" });
    for (const name of [
      "Overview",
      "Products",
      "Orders",
      "Earnings",
      "Inventory",
      "Coupons",
      "Appeals",
      "Back to the shop",
    ])
      await nav.getByRole("link", { name }).waitFor();
    await noOverflowAt320(seller, "/studio/overview");
    await shot(seller, "merchant-01-overview");
  });

  await step("Inventory shows the real Zap hub state and low-stock flags", async () => {
    await seller.goto("/studio/inventory");
    await seller.getByRole("heading", { level: 1, name: "Inventory" }).waitFor();
    await seller.getByText(/Zap hub is currently/).waitFor();
    await seller.getByRole("row", { name: new RegExp(NAME2) }).waitFor();
    await noOverflowAt320(seller, "/studio/inventory");
  });

  await step("S's sixth active coupon is refused with the limit stated", async () => {
    for (let i = 0; i < 3; i++) {
      const made = await call(seller, "POST", "/api/v1/studio/coupons", {
        kind: "PERCENT",
        value: 5,
        isPublic: false,
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
    }
    await seller.goto("/studio/coupons");
    await seller.getByText("5 of 5 active").waitFor();
    await fillCoupon(seller, { percent: 5 });
    await seller
      .getByText(/already have 5 active coupons, the most allowed/)
      .first()
      .waitFor();
    await seller.getByRole("button", { name: `Pause coupon ${PUBLIC_CODE}` }).waitFor();
  });

  await step("B reports the product and gets a reference; the second report is refused plainly", async () => {
    await buyer.goto(`/p/${product1}`);
    await buyer.getByRole("heading", { level: 1, name: NAME1 }).waitFor();
    await buyer.getByRole("button", { name: "Report this product" }).click();
    const dialog = buyer.getByRole("dialog", { name: `Report ${NAME1}` });
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: /Scam/ }).check();
    await dialog.getByLabel(/More detail/).fill("It talks about real card details.");
    await shot(buyer, "merchant-05-report-dialog");
    await dialog.getByRole("button", { name: "Send report" }).click();
    const done = buyer.getByRole("dialog", { name: "Report received" });
    await done.waitFor();
    reference = (await done.getByTestId("report-reference").textContent()).trim();
    assert.ok(reference.length >= 4, `no case reference: ${reference}`);
    await done.getByText("We do not tell the seller who reported.").waitFor();
    await done.getByRole("button", { name: "Done" }).click();
    await buyer.getByRole("button", { name: "Report this product" }).click();
    const again = buyer.getByRole("dialog", { name: `Report ${NAME1}` });
    await again.getByRole("radio", { name: /Something else/ }).check();
    await again.getByRole("button", { name: "Send report" }).click();
    await again
      .getByRole("alert")
      .getByText("You have already reported this. We are looking at it.")
      .waitFor();
    await again.getByRole("button", { name: "Cancel" }).click();
    await buyer.goto("/account/reports");
    await buyer.getByRole("heading", { level: 1, name: "Your reports" }).waitFor();
    const row = buyer.getByRole("row", { name: new RegExp(reference) });
    await row.getByText("Being looked at").waitFor();
    await noOverflowAt320(buyer, "/account/reports");
  });

  await step("a signed-out visitor who presses Report is sent to sign in", async () => {
    await visitor.goto(`/p/${product1}`);
    await visitor.getByRole("button", { name: "Report this product" }).click();
    await visitor.waitForURL(/\/sign-in\?next=/);
  });

  await step("B blocks S's shop: its products vanish for B and B cannot buy; B unblocks", async () => {
    await buyer.goto("/c/impossible-tech");
    await buyer.getByRole("link", { name: NAME2 }).waitFor();
    await buyer.goto(`/store/${HANDLE}`);
    await buyer.getByRole("heading", { level: 1, name: SHOP_NAME }).waitFor();
    await buyer
      .getByText(/stops purchases between you and this shop/)
      .first()
      .waitFor();
    await buyer.getByRole("button", { name: "Block this shop" }).click();
    const dialog = buyer.getByRole("dialog", { name: `Block ${SHOP_NAME}?` });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Block this shop" }).click();
    await buyer.getByText(`You blocked ${SHOP_NAME}. Its products are hidden for you.`).first().waitFor();
    await buyer.getByRole("button", { name: "Unblock this shop" }).waitFor();
    await buyer.goto("/c/impossible-tech");
    await buyer.getByRole("heading", { level: 1, name: "Impossible Tech" }).waitFor();
    await until(
      async () => (await buyer.getByRole("link", { name: NAME2 }).count()) === 0,
      "blocked products to leave the grid",
    );
    assert.equal(await buyer.getByRole("link", { name: NAME1 }).count(), 0);
    await buyer.goto(`/p/${product2}`);
    await buyer.getByText("You blocked this shop").first().waitFor();
    await until(
      async () => await buyer.getByRole("button", { name: "Buy now" }).isDisabled(),
      "Buy now to be disabled",
    );
    const refused = await quote(buyer, product2, companyId);
    assert.ok(refused.status >= 400, `a blocked purchase was accepted: ${refused.status}`);
    // the public HTML is the same for everyone: a signed-out visitor still sees the products
    await visitor.goto("/c/impossible-tech");
    await visitor.getByRole("link", { name: NAME2 }).waitFor();
    await buyer.goto("/account/blocks");
    await buyer.getByRole("heading", { level: 1, name: "Blocked shops" }).waitFor();
    await buyer.getByRole("button", { name: `Unblock ${SHOP_NAME}` }).click();
    await buyer.getByText(`You unblocked ${SHOP_NAME}.`).waitFor();
    await buyer.goto("/c/impossible-tech");
    await buyer.getByRole("link", { name: NAME2 }).waitFor();
    const allowed = await quote(buyer, product2, companyId);
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });

  await step(
    "the admin sees one report case with one numbered reporter and dismisses it with a reason",
    async () => {
      await admin.goto("/console/reports");
      await admin.getByRole("heading", { level: 1, name: "Reports" }).waitFor();
      const card = admin.getByRole("article", { name: `Report case: ${NAME1}` });
      await card.waitFor();
      assert.equal(await admin.getByRole("article", { name: `Report case: ${NAME1}` }).count(), 1);
      const reporters = card.getByRole("list", { name: "Reports in this case" }).getByRole("listitem");
      assert.equal(await reporters.count(), 1);
      await reporters
        .first()
        .getByText(/^Reporter 1:/)
        .waitFor();
      await card
        .getByText(/Scam, or asks for real payment/)
        .first()
        .waitFor();
      await card.getByText("It talks about real card details.").waitFor();
      assert.equal(await card.getByText(/@example\.com/).count(), 0, "a reporter address is on the case");
      await noOverflowAt320(admin, "/console/reports");
      await shot(admin, "merchant-06-console-reports");
      await card.getByRole("button", { name: /^Dismiss/ }).click();
      await card.getByText("Give a reason of at least 5 characters.").waitFor();
      await card.getByLabel(/^Reason/).fill("The listing does not break the rules.");
      await card.getByRole("button", { name: /^Dismiss/ }).click();
      await admin.getByText(`Dismissed: ${NAME1}.`).first().waitFor();
      await until(
        async () => (await admin.getByRole("article", { name: `Report case: ${NAME1}` }).count()) === 0,
        "the case to leave the queue",
      );
      const mine = await call(buyer, "GET", "/api/v1/reports");
      assert.equal(mine.body.items.find((r) => r.reference === reference).status, "DISMISSED");
    },
  );

  await step("a non-admin opening /console/reports sees only 'Not available'", async () => {
    await buyer.goto("/console/reports");
    await buyer.getByRole("heading", { level: 1, name: "Not available" }).waitFor();
  });

  await step(
    "the admin hides S's listing; S sees it hidden and appeals; a second appeal is refused",
    async () => {
      await admin.goto("/console/moderation");
      await admin.getByRole("heading", { level: 1, name: "Moderation" }).waitFor();
      await admin.getByLabel(/^Product id/).fill(product1);
      await admin.getByLabel(/^Reason for hide or restore/).fill("Hidden by the merchant journey test.");
      await admin.getByRole("button", { name: "Hide listing" }).click();
      await admin
        .getByText(/Hidden\. It is off the shop/)
        .first()
        .waitFor();
      await seller.goto("/studio/appeals");
      await seller.getByRole("heading", { level: 1, name: "Appeals" }).waitFor();
      const card = seller.getByRole("article", { name: `Appeal: ${NAME1}` });
      await card.waitFor();
      await card.getByText("Hidden", { exact: true }).first().waitFor();
      await card.getByRole("button", { name: "Send appeal" }).click();
      await card.getByText(/Write at least 20 characters/).waitFor();
      await card
        .getByLabel(/Why should we look again/)
        .fill("This listing follows the rules and was hidden by mistake.");
      await card.getByRole("button", { name: "Send appeal" }).click();
      await card.getByText("Appeal sent").waitFor();
      await seller.getByRole("list", { name: "Appeals" }).getByText("Waiting").first().waitFor();
      await noOverflowAt320(seller, "/studio/appeals");
      const second = await call(seller, "POST", `/api/v1/studio/products/${product1}/appeal`, {
        statement: "A second appeal about the very same decision should not be accepted.",
      });
      assert.ok(second.status >= 400, "a second appeal was accepted");
      assert.ok(
        ["APPEAL_EXISTS", "NOT_APPEALABLE"].includes(second.body.error.code),
        JSON.stringify(second.body),
      );
      await seller.reload();
      await seller.getByRole("heading", { level: 1, name: "Appeals" }).waitFor();
      await seller.getByRole("list", { name: "Appeals" }).waitFor();
      assert.equal(
        await seller.getByRole("article", { name: `Appeal: ${NAME1}` }).count(),
        0,
        "the appeal form is still offered",
      );
    },
  );

  await step(
    "the admin sees the appeal with the original decision and upholds it; the listing is public again",
    async () => {
      await admin.goto("/console/moderation");
      await admin.getByRole("heading", { level: 1, name: "Moderation" }).waitFor();
      const card = admin.getByRole("article", { name: `Appeal: ${NAME1}` });
      await card.waitFor();
      await card.getByText("This listing follows the rules and was hidden by mistake.").waitFor();
      await card.getByText(/Hidden by the merchant journey test\./).waitFor();
      await card.getByText("Original decision").waitFor();
      await card.getByText("Evidence").waitFor();
      await shot(admin, "merchant-07-appeal-in-moderation");
      await card.getByRole("button", { name: /^Uphold/ }).click();
      await card.getByText("Give a reason of at least 5 characters.").waitFor();
      await card.getByLabel(/^Reason/).fill("The hide was a mistake; restoring the listing.");
      await card.getByRole("button", { name: /^Uphold/ }).click();
      await admin
        .getByText(/Appeal upheld/)
        .first()
        .waitFor();
      await visitor.goto(`/p/${product1}`);
      await visitor.getByRole("heading", { level: 1, name: NAME1 }).waitFor();
      await visitor.goto(`/store/${HANDLE}`);
      await visitor.getByRole("link", { name: NAME1 }).waitFor();
      await seller.goto("/studio/appeals");
      await seller.getByRole("list", { name: "Appeals" }).getByText("Upheld").first().waitFor();
      const after = await call(seller, "GET", "/api/v1/studio/earnings?days=7");
      assert.deepEqual(
        [after.body.current.orders, after.body.current.grossPaise, after.body.current.netPaise],
        [earningsBefore.current.orders, earningsBefore.current.grossPaise, earningsBefore.current.netPaise],
        "earnings changed after the appeal",
      );
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
