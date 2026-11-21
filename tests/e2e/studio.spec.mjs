// End-to-end listing studio journey against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/studio.spec.mjs            (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner. 390px viewport.
// Seller S (passport -> shop, done through the API) opens /studio, saves a draft with invalid
// fields (errors), fixes them, checks the preview, submits a Standard listing of 5 units and sees
// it Published; it shows on /store/<handle> and in the catalog signed out. A second listing whose
// text screening sends to review appears in /console/moderation for the Super Admin (made with
// `SUPER_ADMIN_EMAIL=<email> pnpm dev:setup`); a non-admin sees "Not available". The admin rejects
// with a reason; S sees it, edits and resubmits; the admin approves. Buyer B buys S's first product
// with a platform product from the cart (two seller groups). S sees 4 available, 1 sold; changes
// the price; the public page shows it; S cannot buy their own product. An exclusive edition of 3:
// B buys one and the receipt shows "#1 of 3". The admin hides a listing: it leaves the store and
// the catalog and B's collection shows the placeholder. No horizontal overflow at 320px.
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
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-studio-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

// Letters only: random digits can trip text screening.
const letters = (n) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const tag = letters(8);
const phone = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const email = (who) => `${who}-${tag}@example.com`;
const HANDLE = `shop${tag}`;
const SHOP_NAME = `Shop ${tag}`;
const ADMIN_EMAIL = email("admin");

const NAME1 = `Pocket Thundercloud ${letters(6)}`;
const DESC1 = "A small friendly cloud that follows you around and rains only on bad news.";
const NAME2 = `Official Teapot ${letters(6)}`;
const DESC2 = "A teapot that pours a different kind of weather into every cup you make.";
const NAME3 = `Edition Kite ${letters(6)}`;
const DESC3 = "A kite that flies itself and returns before supper, exclusive to three people.";

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

async function fillListing(page, v) {
  await page.getByLabel(/^Name/).fill(v.name);
  if (v.hook) await page.getByLabel(/^Tagline/).fill(v.hook);
  await page.getByLabel(/^Description/).fill(v.description);
  await page.getByLabel(/^Category/).selectOption({ label: "Impossible Tech" });
  await page.getByLabel(/^Price in rupees/).fill(v.price);
  if (v.exclusive) await page.getByRole("radio", { name: /^Exclusive edition/ }).check();
  else await page.getByRole("radio", { name: /^Standard/ }).check();
  await page.getByLabel(/^(Units to stock|Edition supply)/).fill(v.quantity);
}

async function submitForReview(page) {
  await page.getByRole("button", { name: "Submit for review" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit for review?" });
  await dialog.waitFor();
  return dialog;
}

async function confirmSubmit(page) {
  const dialog = await submitForReview(page);
  await dialog.getByRole("button", { name: "Submit for review" }).click();
}

async function listingByName(page, name) {
  const { body } = await call(page, "GET", "/api/v1/studio/products?limit=50");
  const found = body.items.find((l) => (l.live ?? l.pending?.version ?? l.current)?.name === name);
  assert.ok(found, `listing ${name} not found`);
  return found;
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
let first;
let second;
let exclusive;
let platformProduct;

try {
  await step("setup: S gets a shop; the admin account is made Super Admin; B signs up", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    catalog = (await response.json()).items.filter((p) => p.available && p.sellerKey === "SEED");
    assert.ok(catalog.length >= 4, "need platform products (run pnpm dev:setup)");
    platformProduct = catalog[0];
    await signInAndOnboard(seller, email("seller"));
    await openShop(seller, catalog);
    await signInAndOnboard(buyer, email("buyer"));
    await signInAndOnboard(admin, ADMIN_EMAIL);
    execSync("pnpm dev:setup", {
      cwd: REPO,
      env: { ...process.env, SUPER_ADMIN_EMAIL: ADMIN_EMAIL },
      stdio: "pipe",
    });
  });

  await step("S opens /studio: Partner Portal frame, empty state, draft and publish counts", async () => {
    await seller.goto("/studio");
    await seller.getByRole("heading", { level: 1, name: "Your products" }).waitFor();
    await seller.getByText("DeluluMart Partner Portal").waitFor();
    await seller.getByText("You are in the portal, not the shop").waitFor();
    await seller.getByRole("heading", { name: "No listings yet" }).waitFor();
    assert.match(await seller.getByTestId("caps").textContent(), /0 of 20 drafts · 0 of 10 published/);
    await seller
      .getByRole("navigation", { name: "Partner Portal" })
      .getByRole("link", { name: "Back to the shop" })
      .waitFor();
    await noOverflow(seller, "/studio (390)");
    await noOverflowAt320(seller, "/studio");
    await shot(seller, "studio-01-empty-list");
  });

  await step("a person who owns no shop is sent back to /sell", async () => {
    await buyer.goto("/studio");
    await buyer.waitForURL(/\/sell/);
  });

  await step("invalid fields show errors; fixing them clears them and the preview matches", async () => {
    await seller.goto("/studio");
    await seller.getByRole("link", { name: "Create your first listing" }).click();
    await seller.waitForURL(/\/studio\/new/);
    await seller.getByRole("heading", { level: 1, name: "New listing" }).waitFor();
    await seller.getByRole("button", { name: "Save draft" }).click();
    await seller.getByText("Use at least 3 characters.").waitFor();
    await seller.getByText("Use at least 20 characters.").waitFor();
    await seller.getByText("Pick a category.").waitFor();
    await seller.getByText(/whole number of rupees/).waitFor();
    assert.equal(await seller.getByLabel(/^Name/).getAttribute("aria-invalid"), "true");
    await noOverflowAt320(seller, "editor");
    await fillListing(seller, {
      name: NAME1,
      hook: "Rain, but only when deserved.",
      description: DESC1,
      price: "250000",
      quantity: "5",
    });
    assert.equal(await seller.getByLabel(/^Name/).getAttribute("aria-invalid"), null);
    await seller.getByText("₹2,50,000 = ₹2.5 lakh").waitFor();
    await seller.getByText(/You receive the price minus a 5% marketplace fee/).waitFor();
    await seller.getByText(/Uses 5 of your 100 slots; 95 free\./).waitFor();
    await seller.getByRole("button", { name: /^Use suggestion/ }).click();
    const preview = seller.getByTestId("listing-preview");
    await preview.getByText(NAME1).waitFor();
    await preview.getByText("Rain, but only when deserved.").waitFor();
    assert.match(await preview.textContent(), /₹2\.5 lakh/);
    assert.match(await preview.textContent(), new RegExp(SHOP_NAME));
    await shot(seller, "studio-02-editor-with-preview");
  });

  await step("S submits the Standard listing of 5 units; it becomes Published", async () => {
    await confirmSubmit(seller);
    await seller
      .getByText("Your listing passed the check and is published.")
      .first()
      .waitFor({ timeout: 40_000 });
    await seller.getByText("Published", { exact: true }).first().waitFor();
    first = await listingByName(seller, NAME1);
    assert.equal(first.status, "PUBLISHED");
    assert.equal(first.stock.available, 5);
    await seller.getByRole("link", { name: "View the public page" }).waitFor();
  });

  await step("the listing is on /store/<handle> and in the catalog, signed out", async () => {
    await visitor.goto(`/store/${HANDLE}`);
    await visitor.getByRole("heading", { level: 1, name: SHOP_NAME }).waitFor();
    await visitor.getByRole("link", { name: NAME1 }).waitFor();
    const html = await (await visitor.request.get(`/store/${HANDLE}`)).text();
    assert.ok(html.includes(NAME1), "the product is not in the store page's HTML");
    assert.ok(!/@example\.com/.test(html), "an email address is in the public store HTML");
    await noOverflow(visitor, "/store/<handle>");
    await shot(visitor, "studio-03-public-store");
    const catalogNow = (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items;
    assert.ok(catalogNow.some((p) => p.name === NAME1 && p.storeHandle === HANDLE));
    await visitor.goto(`/p/${first.id}`);
    await visitor.getByRole("heading", { level: 1, name: NAME1 }).waitFor();
    await visitor.getByRole("link", { name: SHOP_NAME }).waitFor();
    await visitor.getByText("In stock").first().waitFor();
  });

  await step("a second listing whose text needs review waits for a person", async () => {
    await seller.goto("/studio/new");
    await seller.getByRole("heading", { level: 1, name: "New listing" }).waitFor();
    await fillListing(seller, { name: NAME2, description: DESC2, price: "1800", quantity: "2" });
    await confirmSubmit(seller);
    await seller.getByText("Your listing needs a person to review it.").first().waitFor({ timeout: 40_000 });
    await seller.getByText("Waiting for a person to review.").first().waitFor();
    second = await listingByName(seller, NAME2);
    assert.equal(second.status, "NEEDS_REVIEW");
    await shot(seller, "studio-04-review-needed");
  });

  await step("the admin sees it in /console/moderation (Commerce Console)", async () => {
    await admin.goto("/console/moderation");
    await admin.getByRole("heading", { level: 1, name: "Moderation" }).waitFor();
    await admin.getByText("DeluluMart Commerce Console").waitFor();
    const card = admin.getByRole("article", { name: NAME2 });
    await card.waitFor();
    await card.getByText(new RegExp(`From ${SHOP_NAME}`)).waitFor();
    await card.getByRole("list", { name: "Screening reasons" }).waitFor();
    await noOverflow(admin, "/console/moderation (390)");
    await noOverflowAt320(admin, "/console/moderation");
    await shot(admin, "studio-05-moderation-queue");
  });

  await step("a non-admin opening /console/moderation sees only 'Not available'", async () => {
    await buyer.goto("/console/moderation");
    await buyer.getByRole("heading", { level: 1, name: "Not available" }).waitFor();
    const body = await buyer.locator("body").innerText();
    assert.ok(!/Commerce Console|Moderation|queue/i.test(body), "the page hints at what exists");
    await visitor.goto("/console/moderation");
    await visitor.getByRole("heading", { level: 1, name: "Not available" }).waitFor();
  });

  await step("the admin must give a reason, then rejects with one", async () => {
    const card = admin.getByRole("article", { name: NAME2 });
    await card.getByRole("button", { name: `Reject: ${NAME2}` }).click();
    await card
      .getByText(/at least 5 characters/)
      .first()
      .waitFor();
    await card.getByLabel(/^Reason/).fill("Please use an invented, plainly fictional name.");
    await card.getByRole("button", { name: `Reject: ${NAME2}` }).click();
    await admin
      .getByText(new RegExp(`Rejected: ${NAME2}`))
      .first()
      .waitFor();
    await admin.getByRole("article", { name: NAME2 }).waitFor({ state: "detached" });
  });

  await step("S sees the reason, edits and resubmits; the admin approves; it is Published", async () => {
    await seller.goto(`/studio/${second.id}`);
    await seller.getByText("Not approved", { exact: true }).first().waitFor();
    await seller.getByText(/Please use an invented, plainly fictional name\./).waitFor();
    await seller.getByText(/Edit it and send it again/).waitFor();
    await seller.getByLabel(/^Description/).fill(`${DESC2} It is entirely made up.`);
    await seller.getByRole("button", { name: "Save draft" }).click();
    await seller.getByText("Draft saved. Only you can see it.").first().waitFor();
    await confirmSubmit(seller);
    await seller.getByText("Your listing needs a person to review it.").first().waitFor({ timeout: 40_000 });
    await admin.goto("/console/moderation");
    const card = admin.getByRole("article", { name: NAME2 });
    await card.waitFor();
    await card.getByLabel(/^Reason/).fill("An invented teapot, fine to list.");
    await card.getByRole("button", { name: `Approve: ${NAME2}` }).click();
    await admin
      .getByText(new RegExp(`Approved: ${NAME2}`))
      .first()
      .waitFor();
    await seller.goto(`/studio/${second.id}`);
    await seller.getByText("Published", { exact: true }).first().waitFor();
    second = await listingByName(seller, NAME2);
    assert.equal(second.status, "PUBLISHED");
  });

  await step("B buys S's first product together with a platform product; two seller groups", async () => {
    for (const [id, name] of [
      [first.id, NAME1],
      [platformProduct.id, platformProduct.name],
    ]) {
      await buyer.goto(`/p/${id}`);
      await buyer.getByRole("heading", { level: 1, name }).waitFor();
      await buyer.getByRole("button", { name: new RegExp(`^Add to cart.*${name}`) }).click();
      await buyer.getByRole("link", { name: new RegExp(`^In cart.*${name}`) }).waitFor();
    }
    await buyer.goto("/cart");
    await buyer.getByRole("heading", { level: 1, name: "Your cart" }).waitFor();
    await buyer.getByRole("button", { name: "Check out" }).waitFor();
    await buyer.waitForFunction(
      () => document.querySelector('[aria-label="Order summary"]')?.getAttribute("aria-busy") !== "true",
    );
    await buyer.getByRole("button", { name: "Check out" }).click();
    await payFromBalance(buyer);
    const groups = buyer.getByRole("region", { name: /^Delivery from / });
    await groups.first().waitFor();
    assert.equal(await groups.count(), 2);
    await buyer.getByRole("region", { name: `Delivery from ${SHOP_NAME}` }).waitFor();
    await buyer.getByRole("region", { name: "Delivery from DeluluMart Originals" }).waitFor();
    await noOverflow(buyer, "two-seller success page");
    await shot(buyer, "studio-06-two-seller-success");
  });

  await step("S's listing shows 4 available and 1 sold", async () => {
    await seller.goto(`/studio/${first.id}`);
    await seller.getByText(/4 available · 1 sold/).waitFor();
    await seller.goto("/studio");
    await seller.getByRole("heading", { level: 1, name: "Your products" }).waitFor();
    const row = seller.getByRole("row", { name: new RegExp(NAME1) });
    await row.getByText("4 / 1").waitFor();
  });

  await step("S changes the price with a confirmation; the public page shows the new price", async () => {
    await seller.goto(`/studio/${first.id}`);
    await seller.getByLabel("New price in rupees").fill("3000");
    await seller.getByRole("button", { name: "Change price" }).click();
    const dialog = seller.getByRole("dialog", { name: "Change the price?" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Change price" }).click();
    await seller.getByText("Price changed. Shoppers see the new price now.").first().waitFor();
    await visitor.goto(`/p/${first.id}`);
    await visitor.getByText("₹3,000").first().waitFor();
  });

  await step("S cannot buy their own product", async () => {
    await seller.goto(`/p/${first.id}`);
    await seller.getByRole("heading", { level: 1, name: NAME1 }).waitFor();
    await seller.getByText("This is your listing.").waitFor();
    await seller.getByRole("link", { name: "Manage it in the studio" }).waitFor();
    assert.equal(await seller.getByRole("button", { name: "Buy now" }).count(), 0);
    assert.equal(await seller.getByRole("button", { name: /^Add to cart/ }).count(), 0);
    const added = await call(seller, "POST", "/api/v1/cart/lines", { productId: first.id });
    assert.ok(added.status >= 400, `the server accepted the own product: ${added.status}`);
  });

  await step("an exclusive edition of 3: B buys one and the receipt shows #1 of 3", async () => {
    await seller.goto("/studio/new");
    await seller.getByRole("heading", { level: 1, name: "New listing" }).waitFor();
    await fillListing(seller, {
      name: NAME3,
      description: DESC3,
      price: "5000",
      quantity: "3",
      exclusive: true,
    });
    const dialog = await submitForReview(seller);
    await dialog.getByText(/The supply is fixed forever/).waitFor();
    await dialog.getByText("Exclusive edition", { exact: false }).first().waitFor();
    await dialog.getByRole("button", { name: "Submit for review" }).click();
    await seller
      .getByText("Your listing passed the check and is published.")
      .first()
      .waitFor({ timeout: 40_000 });
    exclusive = await listingByName(seller, NAME3);
    assert.equal(exclusive.edition.supply, 3);
    await visitor.goto(`/p/${exclusive.id}`);
    await visitor.getByText("#0 of 3").first().waitFor();
    await buyer.goto(`/p/${exclusive.id}`);
    await buyer.getByRole("heading", { level: 1, name: NAME3 }).waitFor();
    await buyer.getByText(/Your balance:/).waitFor();
    await buyer.getByRole("button", { name: "Buy now" }).click();
    await payFromBalance(buyer);
    const receipt = buyer.getByRole("region", { name: /Receipt for order/ });
    await receipt.getByText(/#1 of 3/).waitFor();
    await noOverflow(buyer, "exclusive receipt");
    await shot(buyer, "studio-07-exclusive-receipt");
    await buyer.goto("/account/collection");
    await buyer.getByText("#1 of 3").first().waitFor();
  });

  await step(
    "the admin hides a listing: it leaves the store and catalog; B's collection shows a placeholder",
    async () => {
      await admin.goto("/console/moderation");
      await admin.getByRole("heading", { level: 1, name: "Moderation" }).waitFor();
      await admin.getByLabel(/^Product id/).fill(first.id);
      await admin.getByLabel(/^Reason for hide or restore/).fill("Hidden by the journey test.");
      await admin.getByRole("button", { name: "Hide listing" }).click();
      await admin
        .getByText(/Hidden\. It is off the shop/)
        .first()
        .waitFor();
      await visitor.goto(`/store/${HANDLE}`);
      await visitor.getByRole("heading", { level: 1, name: SHOP_NAME }).waitFor();
      assert.equal(
        await visitor.getByRole("link", { name: NAME1 }).count(),
        0,
        "hidden listing still on the store",
      );
      const catalogNow = (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items;
      assert.ok(!catalogNow.some((p) => p.name === NAME1), "hidden listing still in the catalog");
      await visitor.goto(`/p/${first.id}`);
      await visitor.getByRole("heading", { name: "No longer available" }).waitFor();
      await buyer.goto("/account/collection");
      await buyer.getByRole("heading", { level: 1, name: "Your collection" }).waitFor();
      const placeholder = buyer.getByRole("listitem").filter({ hasText: NAME1 });
      await placeholder.getByText("No longer available").waitFor();
      await shot(buyer, "studio-08-collection-placeholder");
      // and S sees why
      await seller.goto(`/studio/${first.id}`);
      await seller.getByText("Hidden", { exact: true }).first().waitFor();
      await seller.getByText(/Hidden by the journey test\./).waitFor();
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
