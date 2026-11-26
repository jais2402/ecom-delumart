import { randomBytes, randomUUID } from "node:crypto";
import { PASSPORT_V1 } from "@delulu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plant } from "../../../packages/db/tests/helpers";
import * as jobsRoute from "../src/app/api/internal/jobs/run/route";
import * as decision from "../src/app/api/v1/admin/listings/[id]/decision/route";
import * as hide from "../src/app/api/v1/admin/listings/[id]/hide/route";
import * as restore from "../src/app/api/v1/admin/listings/[id]/restore/route";
import * as moderation from "../src/app/api/v1/admin/moderation/route";
import * as adminSwitch from "../src/app/api/v1/admin/switches/[name]/route";
import * as cartLines from "../src/app/api/v1/cart/lines/route";
import * as cartPreview from "../src/app/api/v1/cart/preview/route";
import * as companyQuote from "../src/app/api/v1/company/quote/route";
import * as companyRegister from "../src/app/api/v1/company/register/route";
import * as company from "../src/app/api/v1/company/route";
import * as concept from "../src/app/api/v1/passport/concept/route";
import * as quiz from "../src/app/api/v1/passport/quiz/route";
import * as saves from "../src/app/api/v1/saves/route";
import * as storeProducts from "../src/app/api/v1/stores/[handle]/products/route";
import * as archive from "../src/app/api/v1/studio/products/[id]/archive/route";
import * as price from "../src/app/api/v1/studio/products/[id]/price/route";
import * as revise from "../src/app/api/v1/studio/products/[id]/revise/route";
import * as studioProduct from "../src/app/api/v1/studio/products/[id]/route";
import * as salePrice from "../src/app/api/v1/studio/products/[id]/sale-price/route";
import * as shipping from "../src/app/api/v1/studio/products/[id]/shipping/route";
import * as stock from "../src/app/api/v1/studio/products/[id]/stock/route";
import * as submit from "../src/app/api/v1/studio/products/[id]/submit/route";
import * as studioProducts from "../src/app/api/v1/studio/products/route";
import * as zapHub from "../src/app/api/v1/studio/warehouses/[id]/zap-hub/route";
import { JOBS_SIGNATURE_HEADER, JOBS_TIMESTAMP_HEADER, signJobsRequest } from "../src/server/jobs-signature";
import { APP_ORIGIN, startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, type JsonView, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";

/** Player listings through the routes: the studio, the signed job runner, moderation and the public reads. */
let app: TestApp;

beforeAll(async () => {
  // studio tests make more writes per minute than one real player may (production limits unchanged)
  app = await startTestApp({ env: { RATE_LIMIT_MULTIPLIER: "20" } });
});
afterAll(async () => {
  await app.stop();
});

const RIGHT_ANSWERS = Object.fromEntries(PASSPORT_V1.questions.map((q) => [q.id, q.correctOptionId]));
const REASON = "Reported as misleading by buyers.";

const draft = (overrides: Record<string, unknown> = {}) => ({
  name: "Pocket Thunderstorm",
  hook: "Weather you can carry.",
  description: "A small storm in a jar that rains only on your houseplants.",
  category: "impossible-tech",
  templateId: 77,
  altText: "A glass jar with a tiny storm cloud inside",
  priceRupees: 1_000,
  inventoryMode: "STANDARD_STOCKED",
  quantity: 5,
  ...overrides,
});

// ------------------------------------------------------------------ calls
const p = (id: string) => ({ params: { id } });
const createDraft = (b: Browser, body: Record<string, unknown> = draft()) =>
  b.call(studioProducts.POST, "POST", "/api/v1/studio/products", { body });
const listDrafts = (b: Browser, qs = "") => b.call(studioProducts.GET, "GET", `/api/v1/studio/products${qs}`);
const getDraft = (b: Browser, id: string) =>
  b.call(studioProduct.GET, "GET", `/api/v1/studio/products/${id}`, p(id));
const patchDraft = (b: Browser, id: string, body: Record<string, unknown>) =>
  b.call(studioProduct.PATCH, "PATCH", `/api/v1/studio/products/${id}`, { ...p(id), body });
const deleteDraft = (b: Browser, id: string) =>
  b.call(studioProduct.DELETE, "DELETE", `/api/v1/studio/products/${id}`, p(id));
const submitDraft = (b: Browser, id: string) =>
  b.call(submit.POST, "POST", `/api/v1/studio/products/${id}/submit`, p(id));
const stockCall = (b: Browser, id: string, body: Record<string, unknown>) =>
  b.call(stock.POST, "POST", `/api/v1/studio/products/${id}/stock`, { ...p(id), body });
const setPrice = (b: Browser, id: string, priceRupees: number) =>
  b.call(price.POST, "POST", `/api/v1/studio/products/${id}/price`, { ...p(id), body: { priceRupees } });
const setSale = (b: Browser, id: string, salePriceRupees: number, requireReference?: boolean) =>
  b.call(salePrice.PUT, "PUT", `/api/v1/studio/products/${id}/sale-price`, {
    ...p(id),
    body: { salePriceRupees, ...(requireReference === undefined ? {} : { requireReference }) },
  });
const endSaleCall = (b: Browser, id: string) =>
  b.call(salePrice.DELETE, "DELETE", `/api/v1/studio/products/${id}/sale-price`, p(id));
const reviseCall = (b: Browser, id: string, body: Record<string, unknown>) =>
  b.call(revise.POST, "POST", `/api/v1/studio/products/${id}/revise`, { ...p(id), body });
const shippingCall = (b: Browser, id: string, body: Record<string, unknown>) =>
  b.call(shipping.POST, "POST", `/api/v1/studio/products/${id}/shipping`, { ...p(id), body });
const archiveCall = (b: Browser, id: string) =>
  b.call(archive.POST, "POST", `/api/v1/studio/products/${id}/archive`, p(id));
const zapCall = (b: Browser, id: string, enabled: boolean) =>
  b.call(zapHub.POST, "POST", `/api/v1/studio/warehouses/${id}/zap-hub`, { ...p(id), body: { enabled } });
const queue = (b: Browser) => b.call(moderation.GET, "GET", "/api/v1/admin/moderation");
const decide = (b: Browser, id: string, body: Record<string, unknown>) =>
  b.call(decision.POST, "POST", `/api/v1/admin/listings/${id}/decision`, { ...p(id), body });
const hideCall = (b: Browser, id: string, reason = REASON) =>
  b.call(hide.POST, "POST", `/api/v1/admin/listings/${id}/hide`, { ...p(id), body: { reason } });
const restoreCall = (b: Browser, id: string, reason = REASON) =>
  b.call(restore.POST, "POST", `/api/v1/admin/listings/${id}/restore`, { ...p(id), body: { reason } });
const switchCall = (b: Browser, name: string, enabled: boolean, reason = REASON) =>
  b.call(adminSwitch.POST, "POST", `/api/v1/admin/switches/${name}`, {
    params: { name },
    body: { enabled, reason },
  });
const catalogAll = async (): Promise<JsonView[]> => {
  const out: JsonView[] = [];
  let cursor = "";
  for (;;) {
    const res = await new Browser().call(R.catalog.GET, "GET", `/api/v1/catalog?limit=50${cursor}`, {
      cookies: false,
    });
    out.push(...arr(res.json.items));
    if (res.json.nextCursor === null) return out;
    cursor = `&cursor=${str(res.json.nextCursor)}`;
  }
};
const storeList = (handle: string) =>
  new Browser().call(storeProducts.GET, "GET", `/api/v1/stores/${handle}/products`, {
    params: { handle },
    cookies: false,
  });
const productPage = (id: string) =>
  new Browser().call(R.product.GET, "GET", `/api/v1/products/${id}`, { ...p(id), cookies: false });
const balanceOf = async (b: Browser): Promise<bigint> =>
  BigInt(str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise));

/**
 * A fresh signed timestamp per call: an accepted signature is never accepted again (sixth review), so
 * two calls in the same second with the same body take consecutive seconds, as a scheduler would.
 */
let lastTimestamp = 0;
function freshTimestamp(): string {
  lastTimestamp = Math.max(Math.floor(Date.now() / 1000), lastTimestamp + 1);
  return String(lastTimestamp);
}

/** The signed scheduler call. */
async function runJobs(
  options: { body?: string; timestamp?: string | null; signature?: string | null; cookie?: Browser } = {},
): Promise<CallResult> {
  const body = options.body ?? "{}";
  const timestamp = options.timestamp === undefined ? freshTimestamp() : options.timestamp;
  const key = Buffer.from(process.env.JOBS_SIGNING_KEY ?? "", "hex");
  const signature =
    options.signature === undefined ? signJobsRequest(key, timestamp ?? "", body) : options.signature;
  const headers = new Headers({ "content-type": "application/json" });
  if (timestamp !== null) headers.set(JOBS_TIMESTAMP_HEADER, timestamp);
  if (signature !== null) headers.set(JOBS_SIGNATURE_HEADER, signature);
  if (options.cookie) {
    headers.set("cookie", [...options.cookie.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (options.cookie.csrfToken) headers.set("x-csrf-token", options.cookie.csrfToken);
    headers.set("origin", APP_ORIGIN);
  }
  const res = await jobsRoute.POST(
    new Request(new URL("/api/internal/jobs/run", APP_ORIGIN), { method: "POST", headers, body }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: (text ? JSON.parse(text) : {}) as JsonView };
}

/** A player with creator access (the passport) and a registered company, through the routes. */
async function seller(): Promise<{ b: Browser; companyId: string; warehouseId: string; handle: string }> {
  const { b } = await player({ pin: false });
  expect(
    (await b.call(quiz.POST, "POST", "/api/v1/passport/quiz", { body: { answers: RIGHT_ANSWERS } })).json
      .passed,
  ).toBe(true);
  for (const x of app.products) {
    expect((await b.call(saves.POST, "POST", "/api/v1/saves", { body: { productId: x.id } })).status).toBe(
      200,
    );
  }
  const conceptRes = await b.call(concept.POST, "POST", "/api/v1/passport/concept", {
    body: { concept: "A lamp that is mostly moon and partly nap." },
  });
  expect(conceptRes.status).toBe(200);
  const handle = `lamps-${Array.from(randomBytes(8), (b) => "bcdfghjklmnpqrstvwxz"[b % 20]).join("")}`;
  const q = await b.call(companyQuote.POST, "POST", "/api/v1/company/quote", {
    body: { handle, displayName: "Storm Supplies", description: "Weather in jars." },
  });
  expect(q.status).toBe(201);
  const sessionId = str(q.json.sessionId);
  const a = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  const reg = await b.call(companyRegister.POST, "POST", "/api/v1/company/register", {
    body: { sessionId, attemptId: str(a.json.id) },
    idempotencyKey: true,
  });
  expect(reg.status).toBe(201);
  const c = await b.call(company.GET, "GET", "/api/v1/company");
  return {
    b,
    companyId: str(c.json.company?.id),
    warehouseId: str(c.json.company?.warehouses?.starter?.id),
    handle,
  };
}

/** Makes this browser's user the Super Admin (as the database owner, like scripts/dev-setup.ts). */
async function makeAdmin(b: Browser): Promise<void> {
  const ids = [...b.jar.values()].filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const { rowCount } = await app.db.pool.query(
    `UPDATE core.user_profile SET role = 'SUPER_ADMIN'
      WHERE id = (SELECT user_id FROM auth.sessions WHERE id = ANY($1::uuid[]) LIMIT 1)`,
    [ids],
  );
  expect(rowCount).toBe(1);
}

/** Draft → submit → signed job run: a published listing. */
async function publishedListing(b: Browser, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await createDraft(b, draft(overrides));
  expect(created.status).toBe(201);
  const id = str(created.json.product?.id);
  expect((await submitDraft(b, id)).status).toBe(200);
  expect((await runJobs()).status).toBe(200);
  expect((await getDraft(b, id)).json.product?.status).toBe("PUBLISHED");
  return id;
}

function expectPrivate(res: CallResult): void {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

let admin: Browser;
beforeAll(async () => {
  admin = (await player({ pin: false })).b;
  await makeAdmin(admin);
});

// ------------------------------------------------------------------ tests
describe("access guards", () => {
  const id = randomUUID();
  const routes: [string, (b: Browser) => Promise<CallResult>][] = [
    ["GET studio/products", (b) => listDrafts(b)],
    ["POST studio/products", (b) => createDraft(b)],
    ["GET studio/products/:id", (b) => getDraft(b, id)],
    ["PATCH studio/products/:id", (b) => patchDraft(b, id, { name: "Other" })],
    ["DELETE studio/products/:id", (b) => deleteDraft(b, id)],
    ["POST submit", (b) => submitDraft(b, id)],
    ["POST revise", (b) => reviseCall(b, id, { name: "Other" })],
    ["POST price", (b) => setPrice(b, id, 500)],
    ["PUT sale-price", (b) => setSale(b, id, 500)],
    ["DELETE sale-price", (b) => endSaleCall(b, id)],
    ["POST stock", (b) => stockCall(b, id, { action: "RESTOCK", quantity: 1 })],
    ["POST shipping", (b) => shippingCall(b, id, { offersExpress: true })],
    ["POST archive", (b) => archiveCall(b, id)],
    ["POST zap-hub", (b) => zapCall(b, id, true)],
    ["GET admin/moderation", (b) => queue(b)],
    ["POST decision", (b) => decide(b, id, { versionId: id, decision: "APPROVE", reason: REASON })],
    ["POST hide", (b) => hideCall(b, id)],
    ["POST restore", (b) => restoreCall(b, id)],
    ["POST switches", (b) => switchCall(b, "publication", false)],
  ];

  it("401 AUTH_REQUIRED without a sign-in session, private and no-store", async () => {
    const b = new Browser();
    b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    for (const [name, call] of routes) {
      const res = await call(b);
      expect(res.status, name).toBe(401);
      expect(res.json.error?.code, name).toBe("AUTH_REQUIRED");
      expectPrivate(res);
    }
  });

  it("CSRF guards every studio and admin write: no token, a foreign Origin", async () => {
    const { b } = await player({ pin: false });
    for (const [name, call] of routes.filter(([n]) => !n.startsWith("GET"))) {
      const token = b.csrfToken;
      b.csrfToken = null;
      const noToken = await call(b);
      b.csrfToken = token;
      expect(noToken.status, name).toBe(403);
    }
    const foreign = await b.call(studioProducts.POST, "POST", "/api/v1/studio/products", {
      body: draft(),
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
  });

  it("the studio needs creator access and a company", async () => {
    const { b } = await player({ pin: false });
    const res = await createDraft(b);
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("CREATOR_LOCKED");
  });
});

describe("the studio routes", () => {
  let s: Awaited<ReturnType<typeof seller>>;
  beforeAll(async () => {
    s = await seller();
  });

  it("US-08: field shapes are checked before the database, naming the fields (no text echoed)", async () => {
    const res = await createDraft(s.b, draft({ name: "ab", priceRupees: 99, quantity: 0, templateId: 400 }));
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe("VALIDATION_FAILED");
    expect(res.json.error?.details?.reasons).toEqual([
      { field: "name", code: "TOO_SHORT" },
      { field: "templateId", code: "OUT_OF_RANGE" },
      { field: "priceRupees", code: "OUT_OF_RANGE" },
      { field: "quantity", code: "OUT_OF_RANGE" },
    ]);
    expect(res.text).not.toContain('ab"');
    const shape = await createDraft(s.b, { ...draft(), priceRupees: "1000" });
    expect(shape.status).toBe(400);
    const extra = await createDraft(s.b, { ...draft(), sellerId: randomUUID() });
    expect(extra.status).toBe(400);
  });

  it("US-08: create, read, edit, list and delete a draft; responses are private", async () => {
    const created = await createDraft(s.b, draft({ hook: null }));
    expect(created.status).toBe(201);
    expectPrivate(created);
    const id = str(created.json.product?.id);
    expect(created.json.product).toMatchObject({
      status: "DRAFT",
      inventoryMode: "STANDARD_STOCKED",
      quantity: 5,
      nextAction: "SUBMIT",
      current: { revision: 1, name: "Pocket Thunderstorm", hook: null, pricePaise: "100000" },
      live: null,
    });
    const edited = await patchDraft(s.b, id, { name: "Pocket Hailstorm", priceRupees: 1_200 });
    expect(edited.status).toBe(200);
    expect(edited.json.product?.current).toMatchObject({
      revision: 2,
      name: "Pocket Hailstorm",
      pricePaise: "120000",
    });
    const listed = await listDrafts(s.b, "?status=DRAFT");
    expect(arr(listed.json.items).map((i) => i.id)).toContain(id);
    expectPrivate(listed);
    expect((await deleteDraft(s.b, id)).json).toEqual({ deleted: true, id });
    expect((await getDraft(s.b, id)).status).toBe(404);
  });

  it("user B can neither read nor change user A's drafts or stock (404, as for a missing product)", async () => {
    const a = s;
    const bOwner = await seller();
    const draftId = str((await createDraft(a.b)).json.product?.id);
    const liveId = await publishedListing(a.b, { quantity: 2 });
    const missing = randomUUID();
    const tries: [string, (id: string) => Promise<CallResult>][] = [
      ["read", (id) => getDraft(bOwner.b, id)],
      ["edit", (id) => patchDraft(bOwner.b, id, { name: "Mine now" })],
      ["delete", (id) => deleteDraft(bOwner.b, id)],
      ["submit", (id) => submitDraft(bOwner.b, id)],
      ["restock", (id) => stockCall(bOwner.b, id, { action: "RESTOCK", quantity: 1 })],
      ["retire", (id) => stockCall(bOwner.b, id, { action: "RETIRE", quantity: 1 })],
      ["price", (id) => setPrice(bOwner.b, id, 100)],
      ["sale", (id) => setSale(bOwner.b, id, 100)],
      ["end sale", (id) => endSaleCall(bOwner.b, id)],
      ["archive", (id) => archiveCall(bOwner.b, id)],
    ];
    for (const [name, call] of tries) {
      for (const id of [draftId, liveId]) {
        const res = await call(id);
        expect(res.status, `${name} ${id === draftId ? "draft" : "live"}`).toBe(404);
        expect(res.json, name).toEqual((await call(missing)).json);
      }
    }
    expect((await zapCall(bOwner.b, a.warehouseId, true)).status).toBe(404);
    expect(arr((await listDrafts(bOwner.b)).json.items).map((i) => i.id)).not.toContain(draftId);
    expect((await getDraft(a.b, draftId)).json.product).toMatchObject({
      status: "DRAFT",
      current: { revision: 1 },
    });
    expect((await getDraft(a.b, liveId)).json.product).toMatchObject({
      status: "PUBLISHED",
      stock: { available: 2 },
    });
  });

  it("US-29: stock, price, shipping, revision, Zap hub and archive through the routes", async () => {
    const id = await publishedListing(s.b, { quantity: 3 });
    const restocked = await stockCall(s.b, id, { action: "RESTOCK", quantity: 2 });
    expect(restocked.json.product?.stock).toEqual({ available: 5, issued: 0, retired: 0 });
    const retired = await stockCall(s.b, id, { action: "RETIRE", quantity: 1 });
    expect(retired.json).toMatchObject({
      retired: 1,
      sellableSupply: null,
      product: { stock: { available: 4, retired: 1 } },
    });
    expect((await stockCall(s.b, id, { action: "RESTOCK", quantity: 500 })).json.error?.code).toBe(
      "CAPACITY_EXCEEDED",
    );
    expect((await stockCall(s.b, id, { action: "RESTOCK" })).status).toBe(422);
    expect((await setPrice(s.b, id, 1_500)).json.product?.live?.pricePaise).toBe("150000");
    expect(str((await productPage(id)).json.pricePaise)).toBe("150000");
    expect((await shippingCall(s.b, id, { offersExpress: true })).json.product?.offersExpress).toBe(true);
    const revised = await reviseCall(s.b, id, { name: "Pocket Monsoon" });
    expect(revised.json.product).toMatchObject({ status: "PUBLISHED", nextAction: "WAIT_FOR_REVISION" });
    expect((await productPage(id)).json.name).toBe("Pocket Thunderstorm");
    await runJobs();
    expect((await productPage(id)).json.name).toBe("Pocket Monsoon");
    const zap = await zapCall(s.b, s.warehouseId, true);
    expect(arr(zap.json.warehouses).map((w) => [w.id, w.zapHub])).toEqual([[s.warehouseId, true]]);
    expect((await productPage(id)).json.zap).toBe(true);
    const archived = await archiveCall(s.b, id);
    expect(archived.json.product).toMatchObject({ status: "ARCHIVED", stock: { available: 0 } });
    expect((await productPage(id)).json).toEqual({ id, status: "UNAVAILABLE" });
  });
});

describe("sale price routes (R6.2, US-43)", () => {
  let s: Awaited<ReturnType<typeof seller>>;
  beforeAll(async () => {
    s = await seller();
  });
  /** The listing has had its price for `interval` longer (price history never changes: moved as the owner, triggers off). */
  const ageHistory = (id: string, interval: string) =>
    plant(app.db.pool, (c) =>
      c.query("UPDATE core.price_history SET changed_at = changed_at - $2::interval WHERE product_id = $1", [
        id,
        interval,
      ]),
    );

  it("US-43: PUT puts a live listing on sale at once; the studio sees the sale and the history, the shop only the new price", async () => {
    const id = await publishedListing(s.b, { priceRupees: 1_000, quantity: 3 });
    const res = await setSale(s.b, id, 800);
    expect(res.status).toBe(200);
    expectPrivate(res);
    expect(res.json.product).toMatchObject({
      live: { pricePaise: "80000" },
      sale: {
        active: true,
        listPaise: "100000",
        salePaise: "80000",
        referencePaise: null,
        canShowReference: false,
      },
    });
    expect(arr(res.json.product?.priceHistory).map((h) => [h.reason, h.pricePaise])).toEqual([
      ["SALE_START", "80000"],
      ["PUBLISHED", "100000"],
    ]);
    const page = await productPage(id);
    expect(page.json).toMatchObject({ pricePaise: "80000", referencePricePaise: null });
    for (const word of ["listPaise", "salePaise", "priceHistory", "canShowReference", "SALE_START"]) {
      expect(page.text, word).not.toContain(word);
    }
  });

  it("US-43: the shop shows the struck-through previous price only when it was the published price for 24 hours", async () => {
    const id = await publishedListing(s.b, { priceRupees: 1_000, quantity: 3 });
    await ageHistory(id, "25 hours");
    expect((await setSale(s.b, id, 750, true)).status).toBe(200);
    expect((await productPage(id)).json).toMatchObject({
      pricePaise: "75000",
      referencePricePaise: "100000",
    });
    const inCatalog = (await catalogAll()).find((x) => str(x.id) === id);
    expect(inCatalog).toMatchObject({ pricePaise: "75000", referencePricePaise: "100000" });
    expect(arr((await storeList(s.handle)).json.items).find((x) => str(x.id) === id)).toMatchObject({
      pricePaise: "75000",
      referencePricePaise: "100000",
    });
    // ending the sale restores the list price and removes the reference everywhere
    const ended = await endSaleCall(s.b, id);
    expect(ended.status).toBe(200);
    expectPrivate(ended);
    expect(ended.json.product).toMatchObject({ live: { pricePaise: "100000" }, sale: { active: false } });
    expect((await productPage(id)).json).toMatchObject({ pricePaise: "100000", referencePricePaise: null });
  });

  it("US-43: REFERENCE_PRICE_INELIGIBLE (422) when a reference was asked for and does not qualify; nothing changes", async () => {
    const id = await publishedListing(s.b, { priceRupees: 1_000, quantity: 3 });
    const refused = await setSale(s.b, id, 800, true);
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatchObject({ code: "REFERENCE_PRICE_INELIGIBLE", retryable: false });
    expectPrivate(refused);
    expect((await productPage(id)).json.pricePaise).toBe("100000");
    expect((await getDraft(s.b, id)).json.product).toMatchObject({ sale: { active: false } });
    // without the explicit request the sale simply shows the current price
    expect((await setSale(s.b, id, 800, false)).status).toBe(200);
    expect((await productPage(id)).json).toMatchObject({ pricePaise: "80000", referencePricePaise: null });
  });

  it("US-43: refuses a sale price that is not a lower whole-rupee price in range, and a body with other fields", async () => {
    const id = await publishedListing(s.b, { priceRupees: 1_000, quantity: 3 });
    for (const rupees of [1_000, 1_200, 99, 0, -5]) {
      const res = await setSale(s.b, id, rupees);
      expect(res.status, String(rupees)).toBe(422);
      expect(res.json.error?.code, String(rupees)).toBe("VALIDATION_FAILED");
    }
    const bad = await s.b.call(salePrice.PUT, "PUT", `/api/v1/studio/products/${id}/sale-price`, {
      ...p(id),
      body: { salePriceRupees: 800.5 },
    });
    expect(bad.status).toBe(400); // a malformed shape is a request error
    const extra = await s.b.call(salePrice.PUT, "PUT", `/api/v1/studio/products/${id}/sale-price`, {
      ...p(id),
      body: { salePriceRupees: 800, listPaise: "1" },
    });
    expect(extra.status).toBeGreaterThanOrEqual(400);
    expect((await productPage(id)).json.pricePaise).toBe("100000");
    expect((await endSaleCall(s.b, id)).json.error?.code).toBe("NOT_EDITABLE"); // nothing to end
  });

  it("US-08: the list price cannot be changed during a sale (end the sale first)", async () => {
    const id = await publishedListing(s.b, { priceRupees: 1_000, quantity: 3 });
    await setSale(s.b, id, 800);
    const res = await setPrice(s.b, id, 1_200);
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe("NOT_EDITABLE");
  });
});

describe("Super Admin routes", () => {
  it("403 for non-admins, the same answer whether or not the target exists; nothing is written", async () => {
    const s = await seller();
    const id = await publishedListing(s.b);
    const before = await app.db.pool.query("SELECT count(*)::int AS n FROM audit.audit_log");
    const answers = new Set<string>();
    for (const target of [id, randomUUID(), "not-a-uuid"]) {
      for (const res of [
        await hideCall(s.b, target),
        await restoreCall(s.b, target),
        await decide(s.b, target, { versionId: target, decision: "APPROVE", reason: REASON }),
      ]) {
        expect(res.status).toBe(403);
        answers.add(res.text);
      }
    }
    expect(answers.size).toBe(1);
    expect((await queue(s.b)).status).toBe(403);
    expect((await switchCall(s.b, "publication", false)).status).toBe(403);
    expect((await switchCall(s.b, "no-such-switch!", false)).text).toBe([...answers][0]);
    const after = await app.db.pool.query("SELECT count(*)::int AS n FROM audit.audit_log");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await productPage(id)).json.status).toBe("AVAILABLE");
  });

  it("the queue, a decision and a switch, each with an audit row", async () => {
    const s = await seller();
    const created = await createDraft(s.b, draft({ name: "STORM IN A JAR DELUXE" }));
    const id = str(created.json.product?.id);
    await submitDraft(s.b, id);
    expect((await runJobs()).json.report?.screening?.outcomes?.NEEDS_REVIEW).toBe(1);
    const q = await queue(admin);
    expect(q.status).toBe(200);
    expectPrivate(q);
    const item = arr(q.json.items).find((i) => String(i.productId) === id);
    expect(item).toMatchObject({
      kind: "FIRST",
      store: { handle: s.handle },
      version: { name: "STORM IN A JAR DELUXE" },
    });
    expect(arr(item?.reasons)).toContainEqual({ field: "name", code: "CAPS" });
    const badReason = await decide(admin, id, {
      versionId: str(item?.versionId),
      decision: "APPROVE",
      reason: "ok",
    });
    expect(badReason.status).toBe(422);
    const ok = await decide(admin, id, {
      versionId: str(item?.versionId),
      decision: "APPROVE",
      reason: "Capitals are part of the brand.",
    });
    expect(ok.json).toEqual({ outcome: "PUBLISHED", productId: id, versionId: str(item?.versionId) });
    expect((await productPage(id)).json.status).toBe("AVAILABLE");
    const off = await switchCall(admin, "publication", false);
    expect(off.json).toEqual({ name: "publication", enabled: false });
    const paused = await createDraft(s.b, draft());
    const pausedId = str(paused.json.product?.id);
    await submitDraft(s.b, pausedId);
    expect((await runJobs()).json.report?.screening?.paused).toBe(true);
    expect((await getDraft(s.b, pausedId)).json.product?.status).toBe("SCREENING");
    await switchCall(admin, "publication", true);
    await runJobs();
    expect((await getDraft(s.b, pausedId)).json.product?.status).toBe("PUBLISHED");
    const { rows } = await app.db.pool.query<{ action: string }>(
      "SELECT action FROM audit.audit_log WHERE actor_kind = 'SUPER_ADMIN' ORDER BY id DESC LIMIT 3",
    );
    expect(rows.map((r) => r.action)).toEqual(["switch.set", "switch.set", "listing.approve"]);
  });
});

describe("the signed job runner", () => {
  it("refuses a missing, wrong, malformed or stale signature with one answer, and reads no session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const refusals = [
      await runJobs({ timestamp: null }),
      await runJobs({ signature: null }),
      await runJobs({ signature: "0".repeat(64) }),
      await runJobs({ signature: "nothex" }),
      await runJobs({ timestamp: String(now - 61) }),
      await runJobs({ timestamp: String(now + 61) }),
      await runJobs({ timestamp: "12.5" }),
      // a signature for another body
      await runJobs({
        body: '{"budgetMs":1000}',
        signature: signJobsRequest(Buffer.from(process.env.JOBS_SIGNING_KEY ?? "", "hex"), String(now), "{}"),
      }),
      // a signed-in browser with its cookie and CSRF token, but no signature
      await runJobs({ signature: null, cookie: (await player({ pin: false })).b }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.json).toEqual(refusals[0]?.json);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses a replay of the same signed request within the window (sixth review); a fresh request is idempotent", async () => {
    const s = await seller();
    const id = str((await createDraft(s.b)).json.product?.id);
    await submitDraft(s.b, id);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"budgetMs":20000}';
    const first = await runJobs({ timestamp, body });
    expect(first.status).toBe(200);
    expect(first.json.report).toMatchObject({
      screening: { outcomes: { PUBLISHED: 1 }, failed: 0, paused: false },
      safetyNet: { overdue: false, audited: false },
      ratePurged: expect.any(Number),
      idempotencyPurged: expect.any(Number),
      terminated: 0,
    });
    const snapshot = async () =>
      (
        await app.db.pool.query(
          `SELECT (SELECT count(*) FROM core.inventory_unit)::int AS units, (SELECT count(*) FROM audit.outbox)::int AS outbox,
                  (SELECT count(*) FROM audit.audit_log)::int AS audit,
                  (SELECT count(*) FROM core.listing_submission WHERE state = 'SCREENING')::int AS screening`,
        )
      ).rows[0];
    const before = await snapshot();
    // the very same signed request again: refused, with the answer every bad signature gets
    const replay = await runJobs({ timestamp, body });
    expect(replay.status).toBe(403);
    expect(replay.json).toEqual((await runJobs({ signature: "0".repeat(64) })).json);
    expect(await snapshot()).toEqual(before);
    // a fresh signed request runs, and changes nothing the first run did not
    const again = await runJobs({ body });
    expect(again.status).toBe(200);
    expect(again.json.report).toMatchObject({
      screening: { processed: 0, skipped: 0, failed: 0 },
      safetyNet: { overdue: false, audited: false },
      idempotencyPurged: 0,
      terminated: 0,
    });
    expect(await snapshot()).toEqual(before);
    expect((await getDraft(s.b, id)).json.product?.stock).toEqual({ available: 5, issued: 0, retired: 0 });
  });

  it("outside development a submission is never screened inline: it waits for the scheduler", async () => {
    const s = await seller();
    const id = str((await createDraft(s.b)).json.product?.id);
    const submitted = await submitDraft(s.b, id);
    expect(submitted.json.product?.status).toBe("SCREENING");
    await runJobs();
    expect((await getDraft(s.b, id)).json.product?.status).toBe("PUBLISHED");
  });
});

describe("journey", () => {
  it("US-08 US-29: S lists a product, the job publishes it, B buys it with a seed product, S earns the price less 5%; hidden, it leaves every public read while B keeps it", async () => {
    const s = await seller();
    const created = await createDraft(s.b, draft({ name: "Storm Lamp", priceRupees: 2_000, quantity: 4 }));
    expect(created.status).toBe(201);
    const id = str(created.json.product?.id);
    expect((await submitDraft(s.b, id)).json.product?.status).toBe("SCREENING");
    expect((await productPage(id)).status).toBe(404);
    expect((await runJobs()).json.report?.screening?.outcomes?.PUBLISHED).toBe(1);

    // public: catalog, store and product page with the seller
    const inCatalog = (await catalogAll()).find((x) => String(x.id) === id);
    expect(inCatalog).toMatchObject({
      name: "Storm Lamp",
      pricePaise: "200000",
      sellerKey: s.companyId,
      sellerName: "Storm Supplies",
      storeHandle: s.handle,
      inventoryMode: "STANDARD_STOCKED",
      stockBand: "LOW",
      edition: null,
      available: true,
    });
    const store = await storeList(s.handle);
    expect(store.headers.get("cache-control")).toContain("public");
    expect(arr(store.json.items).map((x) => x.id)).toEqual([id]);
    expect((await productPage(id)).json).toMatchObject({ id, status: "AVAILABLE", sellerKey: s.companyId });

    // S cannot buy their own product
    const own = await s.b.call(cartLines.POST, "POST", "/api/v1/cart/lines", { body: { productId: id } });
    expect(own.json.error?.code).toBe("SELF_PURCHASE");

    // B buys it with a seed product: one order group, two seller orders
    const { b } = await player({ pin: false });
    const seed = app.products[0]?.id ?? "";
    for (const x of [id, seed]) {
      expect(
        (await b.call(cartLines.POST, "POST", "/api/v1/cart/lines", { body: { productId: x } })).status,
      ).toBe(200);
    }
    const speeds = { speedBySeller: { SEED: "STANDARD", [s.companyId]: "STANDARD" } };
    const preview = await b.call(cartPreview.POST, "POST", "/api/v1/cart/preview", { body: speeds });
    expect(preview.status).toBe(200);
    const session = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
      body: { source: "CART", ...speeds },
      idempotencyKey: true,
    });
    expect(session.status).toBe(201);
    expect(session.json.totalPaise).toBe(preview.json.totalPaise);
    const sessionId = str(session.json.id);
    const a = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
      params: { id: sessionId },
      body: { method: "BALANCE" },
    });
    const sellerBefore = await balanceOf(s.b);
    const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
      params: { id: sessionId },
      body: { attemptId: str(a.json.id) },
      idempotencyKey: true,
    });
    expect(paid.status).toBe(200);
    const orderId = str(paid.json.orderId);
    const counts = await app.db.pool.query(
      `SELECT (SELECT count(*) FROM core.order_group WHERE session_id = $1)::int AS groups,
              (SELECT count(*) FROM core.seller_order WHERE order_group_id = $2)::int AS seller_orders`,
      [sessionId, orderId],
    );
    expect(counts.rows[0]).toEqual({ groups: 1, seller_orders: 2 });
    // ₹2,000 less the 5% fee
    expect(await balanceOf(s.b)).toBe(sellerBefore + 190_000n);
    expect((await getDraft(s.b, id)).json.product?.stock).toEqual({ available: 3, issued: 1, retired: 0 });

    // the Super Admin hides it: gone from every public read, B still owns it
    const hidden = await hideCall(admin, id);
    expect(hidden.json).toEqual({ outcome: "HIDDEN", productId: id, versionId: null });
    expect((await catalogAll()).map((x) => x.id)).not.toContain(id);
    expect(arr((await storeList(s.handle)).json.items)).toEqual([]);
    expect((await productPage(id)).json).toEqual({ id, status: "UNAVAILABLE" });
    const collection = await b.call(R.collection.GET, "GET", "/api/v1/collection");
    expect(arr(collection.json.items).map((x) => x.productId)).toContain(id);
    expect((await getDraft(s.b, id)).json.product).toMatchObject({
      status: "HIDDEN",
      moderationReason: REASON,
      nextAction: "HIDDEN_BY_MODERATION",
    });
  });
});
