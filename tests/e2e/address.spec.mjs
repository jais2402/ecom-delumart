// End-to-end delivery addresses (PRD R5.2) against a running dev server (AUTH_PROVIDER=dev):
//   node tests/e2e/address.spec.mjs          (BASE_URL defaults to http://localhost:3000)
// Plain Node plus the globally installed `playwright` package; no test runner.
// Seller S opens a shop with one listing. Buyer B adds two addresses in /account/addresses, makes
// Work the default, edits Home, then buys S's listing: the fictional spot is pre-selected, B adds a
// third address from checkout (and is returned there), chooses Home and pays. B's order shows Home;
// S's order view (API and page) shows no address at all. B deletes Home: the old order then shows
// "Address removed" (PRD R5.2: deleting removes it from past orders too). Another player cannot use
// B's address id. Screenshots at 390px and 1280px (device scale 2); no overflow at 320px.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOT_DIR ?? join("/tmp", `delulu-address-${Date.now()}`);
mkdirSync(SHOTS, { recursive: true });

const letters = (n) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const tag = letters(8);
const phone = () => `+91 9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const email = (who) => `${who}-${tag}@example.com`;
const LISTING = `Cloud Kettle ${letters(6)}`;

const HOME = {
  name: "Asha Rao",
  line1: "Flat 4B, Sai Krupa Apartments",
  line2: "12/3, 2nd Cross, Indiranagar",
  city: "Bengaluru",
  state: "Karnataka",
  pin: "560038",
};
const HOME_EDITED_LINE2 = "c/o Meena, 14th Main, Indiranagar";
const WORK = {
  name: "Asha Rao",
  line1: "B-302, Sea Breeze CHS, Plot No. 14",
  line2: "Sector 17, Vashi",
  city: "Navi Mumbai",
  state: "Maharashtra",
  pin: "400703",
};
const OTHER = {
  name: "R. K. Sharma",
  line1: "H.No. 1-2-345/A, Ward No. 7",
  line2: "",
  city: "Hyderabad",
  state: "Telangana",
  pin: "500029",
};

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
    for (const [who, p] of Object.entries({ seller, buyer, stranger })) {
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

/** A full-page screenshot at 390px and at 1280px; 320px is checked for overflow. */
async function shot(page, name) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(150);
    const path = join(SHOTS, `${name}-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await noOverflow(page, `${name} (320)`);
  await page.setViewportSize({ width: 390, height: 844 });
}

async function call(page, method, path, body, idempotent = false) {
  return page.evaluate(
    async ({ m, p, b, i }) => {
      const headers = { accept: "application/json" };
      if (m !== "GET") {
        headers["content-type"] = "application/json";
        headers["x-csrf-token"] = (
          await (await fetch("/api/v1/auth/csrf", { credentials: "same-origin" })).json()
        ).csrfToken;
        if (i) headers["idempotency-key"] = crypto.randomUUID();
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
    { m: method, p: path, b: body, i: idempotent },
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
    handle: `addr${tag}`,
    displayName: `Shop ${tag}`,
    description: "A shop made by the address journey test.",
  });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const attempt = await call(page, "POST", `/api/v1/checkout-sessions/${quote.body.sessionId}/attempts`, {
    method: "BALANCE",
  });
  assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
  const paid = await call(
    page,
    "POST",
    "/api/v1/company/register",
    { sessionId: quote.body.sessionId, attemptId: attempt.body.id },
    true,
  );
  assert.ok(paid.status < 300, JSON.stringify(paid.body));
}

async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function makeListing(page) {
  const created = await call(page, "POST", "/api/v1/studio/products", {
    category: "impossible-tech",
    templateId: 120,
    altText: "A drawing of the product",
    priceRupees: 1500,
    inventoryMode: "STANDARD_STOCKED",
    quantity: 3,
    name: LISTING,
    description: "A kettle that pours exactly one cup of weather, then politely stops.",
  });
  assert.ok(created.status < 300, JSON.stringify(created.body));
  const id = created.body.product.id;
  const submitted = await call(page, "POST", `/api/v1/studio/products/${id}/submit`, {});
  assert.ok(submitted.status < 300, JSON.stringify(submitted.body));
  await until(
    async () =>
      (await call(page, "GET", `/api/v1/studio/products/${id}`)).body.product.status === "PUBLISHED",
    `${LISTING} to be published (are DATABASE_URL_JOBS and JOBS_SIGNING_KEY in apps/web/.env.local?)`,
  );
  return id;
}

/** Fills the address form on the page (the one open form). */
async function fillAddress(page, a, label) {
  await page.getByRole("radio", { name: label, exact: true }).check();
  await page.getByLabel(/^Recipient name/).fill(a.name);
  await page.getByLabel(/^Address line 1/).fill(a.line1);
  await page.getByLabel(/^Address line 2/).fill(a.line2);
  await page.getByLabel(/^City or town/).fill(a.city);
  await page.getByLabel(/^State or union territory/).selectOption({ label: a.state });
  await page.getByLabel(/^PIN code/).fill(a.pin);
}

async function toReview(page) {
  const cont = page.getByRole("button", { name: "Continue to payment" });
  await cont.click();
  await page.getByRole("heading", { level: 2, name: "Payment method" }).waitFor();
  await page.getByRole("radio", { name: /Bank balance/ }).check();
  await page.getByRole("button", { name: "Review your order" }).click();
  await page.getByRole("heading", { level: 2, name: "Review your order" }).waitFor();
}

// ---------------------------------------------------------------- run

const browser = await chromium.launch();
const newContext = () =>
  browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    baseURL: BASE,
  });
const seller = await (await newContext()).newPage();
const buyer = await (await newContext()).newPage();
const stranger = await (await newContext()).newPage();
for (const p of [seller, buyer, stranger]) p.setDefaultTimeout(30_000);

let listingId;
let sellerKey;
let orderId;
let homeId;
let workId;
const SECRETS = [
  HOME.line1,
  "Sai Krupa",
  "Indiranagar",
  "560038",
  "Sea Breeze",
  "400703",
  "Asha Rao",
  "Bengaluru",
];

try {
  await step("setup: S opens a shop with one published listing; B and a stranger sign up", async () => {
    const response = await fetch(`${BASE}/api/v1/catalog?limit=50`);
    assert.equal(response.status, 200);
    const seeds = (await response.json()).items.filter((p) => p.available && p.sellerKey === "SEED");
    assert.ok(seeds.length >= 3, "need platform products (run pnpm dev:setup)");
    await signInAndOnboard(seller, email("seller"));
    await openShop(seller, seeds);
    listingId = await makeListing(seller);
    const listed = (await (await fetch(`${BASE}/api/v1/catalog?limit=50`)).json()).items.find(
      (p) => p.id === listingId,
    );
    sellerKey = listed?.sellerKey;
    assert.ok(sellerKey && sellerKey !== "SEED", "the listing is not in the catalog");
    await signInAndOnboard(buyer, email("buyer"));
    await signInAndOnboard(stranger, email("stranger"));
  });

  await step("the account navigation links to Addresses; the empty state offers to add one", async () => {
    await buyer.goto("/account");
    // the first visit of a dev server compiles the page: give it time
    await buyer.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 120_000 });
    // the sidebar is a collapsed menu at 390px: check the link from the desktop layout
    await buyer.setViewportSize({ width: 1280, height: 900 });
    await buyer.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Addresses" }).click();
    await buyer.waitForURL(/\/account\/addresses$/);
    await buyer.setViewportSize({ width: 390, height: 844 });
    await buyer.getByRole("heading", { level: 1, name: "Addresses" }).waitFor();
    await buyer.getByRole("heading", { name: "No saved addresses" }).waitFor();
    await shot(buyer, "address-01-empty");
  });

  await step(
    "add two addresses (Home, Work) with the form; the notice is shown; the first is the default",
    async () => {
      await buyer.getByRole("button", { name: "Add an address" }).click();
      await buyer.getByRole("heading", { level: 2, name: "Add an address" }).waitFor();
      await buyer.getByText(/Nothing will be delivered to this address/).waitFor();
      await buyer.getByText(/never shown to sellers/).waitFor();
      await fillAddress(buyer, HOME, "Home");
      await shot(buyer, "address-02-form");
      await buyer.getByRole("button", { name: "Save address" }).click();
      await buyer.getByText("Address saved.").waitFor();
      await buyer.getByRole("button", { name: "Add an address" }).click();
      await fillAddress(buyer, WORK, "Work");
      await buyer.getByRole("button", { name: "Save address" }).click();
      await buyer.getByRole("article", { name: "Work" }).waitFor();
      const list = await call(buyer, "GET", "/api/v1/addresses");
      assert.equal(list.status, 200);
      assert.equal(list.body.items.length, 2);
      homeId = list.body.items.find((a) => a.label === "HOME").id;
      workId = list.body.items.find((a) => a.label === "WORK").id;
      assert.equal(list.body.items.find((a) => a.isDefault).id, homeId);
      await buyer.getByRole("article", { name: "Home" }).getByText("Default").waitFor();
    },
  );

  await step("make Work the default, then edit Home", async () => {
    await buyer.getByRole("button", { name: "Make Work the default" }).click();
    await buyer.getByText("Work is now your default address.").waitFor();
    await buyer.getByRole("article", { name: "Work" }).getByText("Default").waitFor();
    await buyer.getByRole("button", { name: "Edit Home" }).click();
    await buyer.getByRole("heading", { level: 2, name: "Edit Home" }).waitFor();
    await buyer.getByLabel(/^Address line 2/).fill(HOME_EDITED_LINE2);
    await buyer.getByRole("button", { name: "Save changes" }).click();
    await buyer.getByText("Address updated.").waitFor();
    await buyer
      .getByRole("article", { name: "Home" })
      .getByText(/c\/o Meena, 14th Main/)
      .waitFor();
    await shot(buyer, "address-03-list");
  });

  await step(
    "checkout: the fictional spot is pre-selected; 'Add a new address' returns to checkout",
    async () => {
      await buyer.goto(`/p/${listingId}`);
      await buyer.getByRole("button", { name: "Buy now" }).click();
      await buyer.waitForURL(/\/checkout\//);
      const checkoutUrl = new URL(buyer.url()).pathname;
      await toReview(buyer);
      const group = buyer.getByRole("group", { name: "Deliver to" });
      await group.waitFor();
      assert.ok(
        await group.getByRole("radio", { name: /Fictional delivery spot/ }).isChecked(),
        "fictional not pre-selected",
      );
      assert.equal(await group.getByRole("radio", { name: /Work/ }).isChecked(), false);
      await shot(buyer, "address-04-checkout-choice");
      await group.getByRole("link", { name: "Add a new address" }).click();
      await buyer.waitForURL(/\/account\/addresses\?add=1&next=/);
      await buyer.getByRole("heading", { level: 2, name: "Add an address" }).waitFor();
      await fillAddress(buyer, OTHER, "Other");
      await buyer.getByRole("button", { name: "Save address" }).click();
      await buyer.waitForURL((u) => u.pathname === checkoutUrl);
    },
  );

  await step("checkout: choose Home and pay; the order shows Home's address", async () => {
    await toReview(buyer);
    const group = buyer.getByRole("group", { name: "Deliver to" });
    await group.getByRole("radio", { name: /Other/ }).waitFor();
    await group.getByRole("radio", { name: /Home/ }).check();
    await buyer.getByRole("button", { name: "Pay now" }).click();
    await buyer.waitForURL(/\/orders\//, { timeout: 30_000 });
    await buyer.getByRole("heading", { level: 1, name: "Order placed" }).waitFor();
    orderId = new URL(buyer.url()).pathname.split("/").pop();
    const section = buyer.getByRole("region", { name: "Delivery address" });
    await section.getByRole("article", { name: "Home" }).waitFor();
    await section.getByText(/c\/o Meena, 14th Main, Indiranagar/).waitFor();
    await section.getByText(/Karnataka 560038/).waitFor();
    await shot(buyer, "address-05-order");
  });

  await step(
    "the seller's order view (API and page) carries no address, name, PIN code or label",
    async () => {
      const list = await call(seller, "GET", "/api/v1/studio/orders?limit=10");
      assert.equal(list.status, 200);
      assert.equal(list.body.items.length, 1);
      const ref = list.body.items[0].id;
      const one = await call(seller, "GET", `/api/v1/studio/orders/${ref}`);
      const text = JSON.stringify([list.body, one.body]);
      for (const s of [...SECRETS, HOME_EDITED_LINE2, homeId, "address", "Karnataka"]) {
        assert.ok(!text.includes(s), `seller API shows ${s}`);
      }
      await seller.goto(`/studio/orders/${ref}`);
      await seller.getByRole("heading", { level: 1, name: /^Order of/ }).waitFor();
      await seller.getByText("Anonymous player").first().waitFor();
      const page = await seller.locator("body").innerText();
      for (const s of [...SECRETS, "Meena", "Karnataka"])
        assert.ok(!page.includes(s), `seller page shows ${s}`);
      await shot(seller, "address-06-seller-order");
    },
  );

  await step("another player cannot use, edit or delete B's address id", async () => {
    const q = await call(
      stranger,
      "POST",
      "/api/v1/checkout-sessions",
      { lines: [{ productId: listingId }], speedBySeller: { [sellerKey]: "STANDARD" }, addressId: workId },
      true,
    );
    assert.equal(q.status, 404, JSON.stringify(q.body));
    assert.equal(q.body.error.code, "ADDRESS_NOT_FOUND");
    for (const [m, p, b] of [
      ["PATCH", `/api/v1/addresses/${workId}`, { label: "OTHER" }],
      ["DELETE", `/api/v1/addresses/${workId}`, undefined],
      ["POST", `/api/v1/addresses/${workId}/default`, undefined],
    ]) {
      const r = await call(stranger, m, p, b);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.error.code, "ADDRESS_NOT_FOUND");
    }
    assert.equal((await call(stranger, "GET", `/api/v1/orders/${orderId}`)).status, 404);
    assert.equal((await call(stranger, "GET", "/api/v1/addresses")).body.items.length, 0);
  });

  await step(
    "delete Home (with a confirmation dialog); the old order then shows 'Address removed'",
    async () => {
      await buyer.goto("/account/addresses");
      await buyer.getByRole("button", { name: "Delete Home" }).click();
      const dialog = buyer.getByRole("dialog", { name: "Delete Home?" });
      await dialog.waitFor();
      await shot(buyer, "address-07-delete-dialog");
      await dialog.getByRole("button", { name: "Delete address" }).click();
      await buyer.getByText(/Address deleted/).waitFor();
      await buyer.getByRole("article", { name: "Home" }).waitFor({ state: "detached" });
      await buyer.goto(`/orders/${orderId}`);
      const section = buyer.getByRole("region", { name: "Delivery address" });
      await section.getByText("Address removed").waitFor();
      const page = await buyer.locator("body").innerText();
      assert.ok(!page.includes("14th Main"), "the deleted address is still on the order");
      await shot(buyer, "address-08-order-address-removed");
    },
  );
} catch {
  console.log(`\nStopped at: ${current}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed${process.exitCode ? " (stopped early)" : ""}`);
  console.log(`Screenshots (${SHOTS}):`);
  for (const path of shots) console.log(`  ${path}`);
}
