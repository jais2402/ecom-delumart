import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as appealResolve from "../src/app/api/v1/admin/appeals/[id]/resolve/route";
import * as moderation from "../src/app/api/v1/admin/moderation/route";
import * as reportResolve from "../src/app/api/v1/admin/reports/[id]/resolve/route";
import * as adminReports from "../src/app/api/v1/admin/reports/route";
import * as blocks from "../src/app/api/v1/blocks/route";
import * as reports from "../src/app/api/v1/reports/route";
import * as storeCoupons from "../src/app/api/v1/stores/[handle]/coupons/route";
import * as studioAppeals from "../src/app/api/v1/studio/appeals/route";
import * as brandProgress from "../src/app/api/v1/studio/brand-progress/route";
import * as couponStatus from "../src/app/api/v1/studio/coupons/[id]/status/route";
import * as coupons from "../src/app/api/v1/studio/coupons/route";
import * as earnings from "../src/app/api/v1/studio/earnings/route";
import * as inventory from "../src/app/api/v1/studio/inventory/route";
import * as studioOrder from "../src/app/api/v1/studio/orders/[id]/route";
import * as studioOrders from "../src/app/api/v1/studio/orders/route";
import * as appeal from "../src/app/api/v1/studio/products/[id]/appeal/route";
import * as studioProduct from "../src/app/api/v1/studio/products/[id]/route";
import { PUBLIC_CACHE } from "../src/server/http";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";
import {
  ageAccount,
  aMinuteLater,
  makeAdmin,
  publishedListing,
  type Seller,
  seller,
  userIdOf,
} from "./helpers/studio";

/** Reports, appeals, blocks, merchant coupons and the merchant read models through the routes. */
let app: TestApp;
let admin: Browser;

beforeAll(async () => {
  // these flows make more studio and report calls per minute than one real player may (production
  // limits unchanged; the database's own five-reports-per-hour check is not scaled)
  app = await startTestApp({ env: { RATE_LIMIT_MULTIPLIER: "20" } });
  admin = (await player({ pin: false })).b;
  await makeAdmin(app, admin);
});
afterAll(async () => {
  await app.stop();
});

const REASON = "Reviewed the listing and the reports.";
const STATEMENT = "This storm in a jar is a joke product and breaks no rule; please look again.";
const p = (id: string) => ({ params: { id } });

// ------------------------------------------------------------------ calls
const postReport = (b: Browser, body: Record<string, unknown>) =>
  b.call(reports.POST, "POST", "/api/v1/reports", { body });
const reportProduct = (b: Browser, id: string, reason = "SCAM_OR_PAYMENT") =>
  postReport(b, { targetType: "PRODUCT", targetId: id, reason });
const listReports = (b: Browser) => b.call(reports.GET, "GET", "/api/v1/reports");
const postAppeal = (b: Browser, id: string, statement = STATEMENT) =>
  b.call(appeal.POST, "POST", `/api/v1/studio/products/${id}/appeal`, { ...p(id), body: { statement } });
const listAppeals = (b: Browser) => b.call(studioAppeals.GET, "GET", "/api/v1/studio/appeals");
const getProduct = (b: Browser, id: string) =>
  b.call(studioProduct.GET, "GET", `/api/v1/studio/products/${id}`, p(id));
const listBlocks = (b: Browser) => b.call(blocks.GET, "GET", "/api/v1/blocks");
const block = (b: Browser, companyId: string) =>
  b.call(blocks.POST, "POST", "/api/v1/blocks", { body: { companyId } });
const unblock = (b: Browser, companyId: string) =>
  b.call(blocks.DELETE, "DELETE", "/api/v1/blocks", { body: { companyId } });
const listCoupons = (b: Browser) => b.call(coupons.GET, "GET", "/api/v1/studio/coupons");
const postCoupon = (b: Browser, body: Record<string, unknown>) =>
  b.call(coupons.POST, "POST", "/api/v1/studio/coupons", { body });
const setStatus = (b: Browser, id: string, status: string) =>
  b.call(couponStatus.POST, "POST", `/api/v1/studio/coupons/${id}/status`, { ...p(id), body: { status } });
const publicCoupons = (handle: string) =>
  new Browser().call(storeCoupons.GET, "GET", `/api/v1/stores/${handle}/coupons`, {
    params: { handle },
    cookies: false,
  });
const orders = (b: Browser) => b.call(studioOrders.GET, "GET", "/api/v1/studio/orders");
const order = (b: Browser, id: string) =>
  b.call(studioOrder.GET, "GET", `/api/v1/studio/orders/${id}`, p(id));
const earningsOf = (b: Browser, qs = "") => b.call(earnings.GET, "GET", `/api/v1/studio/earnings${qs}`);
const brand = (b: Browser) => b.call(brandProgress.GET, "GET", "/api/v1/studio/brand-progress");
const stock = (b: Browser) => b.call(inventory.GET, "GET", "/api/v1/studio/inventory");
const casesOf = (b: Browser) => b.call(adminReports.GET, "GET", "/api/v1/admin/reports");
const resolveCase = (b: Browser, id: string, outcome: string, reason = REASON) =>
  b.call(reportResolve.POST, "POST", `/api/v1/admin/reports/${id}/resolve`, {
    ...p(id),
    body: { outcome, reason },
  });
const resolveAppealCall = (b: Browser, id: string, outcome: string, reason = REASON) =>
  b.call(appealResolve.POST, "POST", `/api/v1/admin/appeals/${id}/resolve`, {
    ...p(id),
    body: { outcome, reason },
  });
const queue = (b: Browser) => b.call(moderation.GET, "GET", "/api/v1/admin/moderation");
const productPage = (id: string) =>
  new Browser().call(R.product.GET, "GET", `/api/v1/products/${id}`, { ...p(id), cookies: false });
const overlay = (b: Browser, ids: string[] = []) =>
  b.call(R.overlay.GET, "GET", `/api/v1/me/overlay?productIds=${ids.join(",")}`);

/** Quote and pay for one product of one store at Standard delivery, optionally with a coupon. */
async function buy(b: Browser, productId: string, companyId: string, couponCode?: string) {
  const quote = await b.call(R.checkoutSessions.POST, "POST", "/api/v1/checkout-sessions", {
    body: {
      lines: [{ productId }],
      speedBySeller: { [companyId]: "STANDARD" },
      ...(couponCode ? { couponCode } : {}),
    },
    idempotencyKey: true,
  });
  if (quote.status !== 201) return { quote, paid: null };
  const sessionId = str(quote.json.id);
  const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(attempt.json.id) },
    idempotencyKey: true,
  });
  return { quote, paid };
}

const expectPrivate = (res: CallResult) => expect(res.headers.get("cache-control")).toBe("private, no-store");

// ------------------------------------------------------------------ guards
describe("access guards", () => {
  const id = randomUUID();
  const routes: [string, (b: Browser) => Promise<CallResult>][] = [
    ["GET reports", (b) => listReports(b)],
    ["POST reports", (b) => reportProduct(b, id)],
    ["POST appeal", (b) => postAppeal(b, id)],
    ["GET studio/appeals", (b) => listAppeals(b)],
    ["GET blocks", (b) => listBlocks(b)],
    ["POST blocks", (b) => block(b, id)],
    ["DELETE blocks", (b) => unblock(b, id)],
    ["GET studio/coupons", (b) => listCoupons(b)],
    ["POST studio/coupons", (b) => postCoupon(b, { kind: "PERCENT", value: 10, isPublic: false })],
    ["POST coupon status", (b) => setStatus(b, id, "PAUSED")],
    ["GET studio/orders", (b) => orders(b)],
    ["GET studio/orders/:id", (b) => order(b, id)],
    ["GET studio/earnings", (b) => earningsOf(b)],
    ["GET studio/brand-progress", (b) => brand(b)],
    ["GET studio/inventory", (b) => stock(b)],
    ["GET admin/reports", (b) => casesOf(b)],
    ["POST admin/reports resolve", (b) => resolveCase(b, id, "DISMISSED")],
    ["POST admin/appeals resolve", (b) => resolveAppealCall(b, id, "DENIED")],
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

  it("CSRF guards every write: no token, a foreign Origin", async () => {
    const { b } = await player({ pin: false });
    for (const [name, call] of routes.filter(([n]) => !n.startsWith("GET"))) {
      const token = b.csrfToken;
      b.csrfToken = null;
      const noToken = await call(b);
      b.csrfToken = token;
      expect(noToken.status, name).toBe(403);
    }
    const foreign = await b.call(reports.POST, "POST", "/api/v1/reports", {
      body: { targetType: "STORE", targetId: id, reason: "OTHER" },
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
  });

  it("merchant reads need a company; a player without one gets 403 COMPANY_FEE_REQUIRED", async () => {
    const { b } = await player({ pin: false });
    for (const call of [orders, earningsOf, brand, stock, listCoupons]) {
      const res = await call(b);
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe("COMPANY_FEE_REQUIRED");
    }
  });

  it("Super Admin routes: 403 for non-admins, the same answer whether or not the target exists", async () => {
    const s = await seller(app);
    const productId = await publishedListing(s.b);
    const r = await player({ pin: false });
    expect((await reportProduct(r.b, productId)).status).toBe(201);
    const { rows } = await app.db.pool.query<{ id: string }>(
      "SELECT id FROM core.report_case WHERE product_id = $1",
      [productId],
    );
    const caseId = str(rows[0]?.id);
    const answers = new Set<string>();
    for (const target of [caseId, randomUUID(), "not-a-uuid"]) {
      for (const res of [
        await resolveCase(s.b, target, "DISMISSED"),
        await resolveAppealCall(s.b, target, "UPHELD"),
      ]) {
        expect(res.status).toBe(403);
        answers.add(res.text);
      }
    }
    expect(answers.size).toBe(1);
    expect((await casesOf(s.b)).status).toBe(403);
    // the Super Admin gets 404 for a missing target
    expect((await resolveCase(admin, randomUUID(), "DISMISSED")).status).toBe(404);
    expect((await resolveAppealCall(admin, "not-a-uuid", "DENIED")).status).toBe(404);
  });
});

// ------------------------------------------------------------------ reports and blocks
describe("reports and blocks", () => {
  let s: Seller;
  beforeAll(async () => {
    s = await seller(app);
  });

  it("§7.7: a report returns its case reference; shapes are checked; each user lists only their own", async () => {
    const productId = await publishedListing(s.b);
    const { b } = await player({ pin: false });
    const made = await postReport(b, {
      targetType: "PRODUCT",
      targetId: productId,
      reason: "IMPERSONATION",
      detail: "Pretends to be a real brand.",
    });
    expect(made.status).toBe(201);
    expectPrivate(made);
    expect(str(made.json.reference)).toMatch(/^R-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    expect((await reportProduct(b, productId)).json.error?.code).toBe("ALREADY_REPORTED");
    expect(
      (await postReport(b, { targetType: "PRODUCT", targetId: productId, reason: "BORING" })).status,
    ).toBe(400);
    const long = await postReport(b, {
      targetType: "STORE",
      targetId: s.companyId,
      reason: "OTHER",
      detail: "x".repeat(501),
    });
    expect(long.status).toBe(422);
    expect(long.json.error?.details?.reasons).toEqual([{ field: "detail", code: "TOO_LONG" }]);
    const mine = await listReports(b);
    expect(arr(mine.json.items).map((i) => i.reference)).toEqual([made.json.reference]);
    expect(arr(mine.json.items)[0]).toMatchObject({
      targetType: "PRODUCT",
      targetId: productId,
      status: "OPEN",
    });
    const other = await player({ pin: false });
    expect(arr((await listReports(other.b)).json.items)).toEqual([]);
    // the owner's studio view never shows who reported or what they wrote
    const studio = await getProduct(s.b, productId);
    expect(studio.text).not.toContain("Pretends to be a real brand");
    expect(studio.text).not.toContain(await userIdOf(app, b));
  });

  it("§11.2: the sixth report within the hour is 429 REPORT_LIMIT", async () => {
    const { b } = await player({ pin: false });
    const targets = [];
    for (let i = 0; i < 5; i++) targets.push(await publishedListing(s.b, { quantity: 1 }));
    for (const t of targets) expect((await reportProduct(b, t)).status).toBe(201);
    const sixth = await postReport(b, { targetType: "STORE", targetId: s.companyId, reason: "OTHER" });
    expect(sixth.status).toBe(429);
    expect(sixth.json.error?.code).toBe("REPORT_LIMIT");
  });

  it("§7.7: a block hides the store in the blocker's overlay and refuses purchases both ways, invisibly", async () => {
    const other = await seller(app);
    const sProduct = await publishedListing(s.b, { quantity: 3 });
    const oProduct = await publishedListing(other.b, { quantity: 3 });
    const blocked = await block(other.b, s.companyId);
    expect(blocked.json).toEqual({ companyId: s.companyId, blocked: true });
    expect(arr((await listBlocks(other.b)).json.items).map((x) => x.companyId)).toEqual([s.companyId]);
    expect((await overlay(other.b, [sProduct])).json.blockedSellerKeys).toEqual([s.companyId]);
    // the blocked store sees nothing of it
    expect(arr((await listBlocks(s.b)).json.items)).toEqual([]);
    expect((await overlay(s.b)).json.blockedSellerKeys).toEqual([]);
    for (const [buyer, productId, companyId] of [
      [other.b, sProduct, s.companyId],
      [s.b, oProduct, other.companyId],
    ] as const) {
      const { quote } = await buy(buyer, productId, companyId);
      expect(quote.status).toBe(409);
      expect(quote.json.error?.code).toBe("PRODUCT_UNAVAILABLE");
    }
    expect((await block(other.b, other.companyId)).json.error?.code).toBe("VALIDATION_FAILED");
    expect((await block(other.b, randomUUID())).status).toBe(404);
    expect((await unblock(other.b, s.companyId)).json).toEqual({ companyId: s.companyId, blocked: false });
    expect((await buy(other.b, sProduct, s.companyId)).paid?.status).toBe(200);
  });
});

// ------------------------------------------------------------------ coupons and merchant reads
describe("coupons and merchant reads", () => {
  it("US-41: create, list (codes for the owner only), pause and the five-active limit; public coupons are cacheable", async () => {
    const s = await seller(app);
    const priv = await postCoupon(s.b, { kind: "PERCENT", value: 15, isPublic: false });
    expect(priv.status).toBe(201);
    expect(str(priv.json.code)).toMatch(/^[A-Z2-9]{16}$/);
    const pub = await postCoupon(s.b, {
      kind: "FLAT",
      value: 200,
      minSpendRupees: 1_000,
      isPublic: true,
      publicCode: "storm200",
    });
    expect(pub.json.code).toBe("STORM200");
    expect((await postCoupon(s.b, { kind: "PERCENT", value: 10, isPublic: true })).status).toBe(422);
    expect((await postCoupon(s.b, { kind: "PERCENT", value: 95, isPublic: false })).json.error?.code).toBe(
      "VALIDATION_FAILED",
    );
    const listed = await listCoupons(s.b);
    expectPrivate(listed);
    expect(listed.json).toMatchObject({ activeCount: 2, activeMax: 5 });
    expect(
      arr(listed.json.items)
        .map((c) => c.code)
        .sort(),
    ).toEqual([priv.json.code, "STORM200"].sort());
    expect(arr(listed.json.items).find((c) => String(c.code) === "STORM200")).toMatchObject({
      kind: "FLAT",
      amountPaise: "20000",
      minSpendPaise: "100000",
      isPublic: true,
      status: "ACTIVE",
      redeemed: 0,
      discountGivenPaise: "0",
    });
    const pubs = await publicCoupons(s.handle);
    expect(pubs.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(arr(pubs.json.items).map((c) => c.code)).toEqual(["STORM200"]);
    expect(pubs.text).not.toContain(str(priv.json.code));
    expect((await publicCoupons("no-such-store")).status).toBe(404);
    for (let i = 0; i < 3; i++)
      expect((await postCoupon(s.b, { kind: "PERCENT", value: 5, isPublic: false })).status).toBe(201);
    const sixth = await postCoupon(s.b, { kind: "PERCENT", value: 5, isPublic: false });
    expect(sixth.status).toBe(409);
    expect(sixth.json.error?.code).toBe("COUPON_LIMIT");
    expect((await setStatus(s.b, str(pub.json.id), "PAUSED")).json).toEqual({
      id: pub.json.id,
      status: "PAUSED",
    });
    expect(arr((await publicCoupons(s.handle)).json.items)).toEqual([]);
    const stranger = await seller(app);
    expect((await setStatus(stranger.b, str(pub.json.id), "ENDED")).status).toBe(403);
    expect(arr((await listCoupons(stranger.b)).json.items)).toEqual([]);
  });

  it("isolation: user B cannot read user A's seller orders, earnings or inventory", async () => {
    const a = await seller(app);
    const b = await seller(app);
    const productId = await publishedListing(a.b, { quantity: 2 });
    const buyer = await player({ pin: false });
    expect((await buy(buyer.b, productId, a.companyId)).paid?.status).toBe(200);
    await aMinuteLater(app); // 0060: a seller sees an order once its minute has ended
    const aOrders = await orders(a.b);
    expect(arr(aOrders.json.items)).toHaveLength(1);
    const orderId = str(arr(aOrders.json.items)[0]?.id);
    expect((await order(a.b, orderId)).status).toBe(200);
    const missing = await order(b.b, randomUUID());
    const foreign = await order(b.b, orderId);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(missing.json);
    expect(arr((await orders(b.b)).json.items)).toEqual([]);
    expect((await earningsOf(b.b)).json.current?.orders).toBe(0);
    expect(arr((await stock(b.b)).json.products)).toEqual([]);
    expect((await stock(a.b)).json.products?.[0]).toMatchObject({ id: productId, available: 1, issued: 1 });
    expect((await earningsOf(a.b, "?days=400")).json.periodDays).toBe(90);
    expect((await earningsOf(a.b, "?days=0")).status).toBe(400);
  });
});

// ------------------------------------------------------------------ the journey
describe("journey: sell, coupon, buy, earnings, reports, appeal", () => {
  it("US-41, US-45, §7.7: a seller's sale with a coupon, the automatic hide and an upheld appeal", async () => {
    // S lists and publishes a product
    const s = await seller(app);
    const productId = await publishedListing(s.b, { priceRupees: 10_000, quantity: 5 });
    expect((await productPage(productId)).json).toMatchObject({
      status: "AVAILABLE",
      referencePricePaise: null,
    });

    // S creates a public 10% coupon
    const made = await postCoupon(s.b, {
      kind: "PERCENT",
      value: 10,
      isPublic: true,
      publicCode: "JOURNEY10",
    });
    expect(made.status).toBe(201);
    expect(arr((await publicCoupons(s.handle)).json.items).map((c) => c.code)).toEqual(["JOURNEY10"]);

    // B buys with the coupon: 90% plus Standard delivery
    const B = await player({ pin: false });
    const before = BigInt(str((await B.b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise));
    const { quote, paid } = await buy(B.b, productId, s.companyId, "journey10");
    expect(quote.json.totalPaise).toBe(String(900_000 + 100_000));
    expect(paid?.status).toBe(200);
    const after = BigInt(str((await B.b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise));
    expect(before - after).toBe(1_000_000n);

    // S's orders and earnings show it, with no buyer identity: net = 90% less the 5% fee
    await aMinuteLater(app); // 0060: a seller sees an order once its minute has ended
    const listed = await orders(s.b);
    expectPrivate(listed);
    const o = arr(listed.json.items)[0];
    expect(o).toMatchObject({
      buyer: "Anonymous player",
      source: "PLAYER",
      listPaise: "1000000",
      discountPaise: "100000",
      grossPaise: "900000",
      feePaise: "45000",
      deliveryFeeBuyerPaise: "100000",
      deliveryFeeSellerPaise: "0",
      netPaise: "855000",
      couponCode: "JOURNEY10",
    });
    const buyerId = await userIdOf(app, B.b);
    expect(listed.text).not.toContain(buyerId);
    const earned = await earningsOf(s.b);
    expect(earned.json.current).toMatchObject({
      orders: 1,
      grossPaise: "900000",
      feesPaise: "45000",
      netPaise: "855000",
      distinctBuyers: 1,
      averageOrderPaise: "900000",
    });
    expect(earned.text).not.toContain(buyerId);
    const coupon = arr((await listCoupons(s.b)).json.items).find((c) => String(c.code) === "JOURNEY10");
    expect(coupon).toMatchObject({ redeemed: 1, discountGivenPaise: "100000" });

    // brand progress counts B only once B's account is old enough
    expect((await brand(s.b)).json).toMatchObject({ qualifyingGrossPaise: "900000", eligibleBuyers: 0 });
    await ageAccount(app, B.b, 25);
    expect((await brand(s.b)).json).toMatchObject({
      qualifyingGrossPaise: "900000",
      eligibleBuyers: 1,
      thresholdPaise: "10000000000",
      minBuyers: 5,
      qualifies: false,
      brandUnlocked: false,
    });

    // three established users (a week old, sixth review) report the product: it is hidden at once
    // and gone from the catalog
    const reporters = [];
    for (let i = 0; i < 3; i++) {
      const r = await player({ pin: false });
      await ageAccount(app, r.b, 8 * 24);
      reporters.push(r.b);
    }
    expect((await reportProduct(reporters[0] as Browser, productId)).status).toBe(201);
    expect((await reportProduct(reporters[1] as Browser, productId, "HATE")).status).toBe(201);
    expect((await productPage(productId)).json.status).toBe("AVAILABLE");
    expect((await reportProduct(reporters[2] as Browser, productId)).status).toBe(201);
    expect((await productPage(productId)).json).toEqual({ id: productId, status: "UNAVAILABLE" });
    const cases = await casesOf(admin);
    const theCase = arr(cases.json.items).find((c) => String(c.target?.productId) === productId);
    expect(theCase).toMatchObject({
      autoHidden: true,
      reporterCount: 3,
      reasonCounts: { SCAM_OR_PAYMENT: 2, HATE: 1 },
    });
    for (const r of reporters) expect(cases.text).not.toContain(await userIdOf(app, r));

    // S sees why, and appeals once
    const hidden = await getProduct(s.b, productId);
    expect(hidden.json.product).toMatchObject({
      status: "HIDDEN",
      moderationReason: "Hidden pending review",
      appealable: true,
      appeal: null,
    });
    const appealed = await postAppeal(s.b, productId);
    expect(appealed.status).toBe(201);
    const appealId = str(appealed.json.appeal?.id);
    expect((await postAppeal(s.b, productId)).json.error?.code).toBe("APPEAL_EXISTS");
    expect(arr((await listAppeals(s.b)).json.items)[0]).toMatchObject({
      id: appealId,
      status: "OPEN",
      kind: "HIDE",
    });
    const queued = arr((await queue(admin)).json.appeals).find((a) => String(a.appealId) === appealId);
    expect(queued).toMatchObject({
      statement: STATEMENT,
      decision: { action: "HIDDEN", reason: "Hidden pending review", by: "REPORTS" },
      evidence: { reports: { reporterCount: 3 } },
    });

    // the Super Admin upholds the appeal: public again, S's totals unchanged
    const upheld = await resolveAppealCall(admin, appealId, "UPHELD");
    expect(upheld.json).toMatchObject({ outcome: "UPHELD", effect: "RESTORED", productStatus: "PUBLISHED" });
    expect((await productPage(productId)).json.status).toBe("AVAILABLE");
    expect((await getProduct(s.b, productId)).json.product).toMatchObject({
      status: "PUBLISHED",
      stock: { available: 4, issued: 1 },
      appeal: { status: "UPHELD" },
    });
    expect((await earningsOf(s.b)).json.current).toMatchObject({
      orders: 1,
      grossPaise: "900000",
      netPaise: "855000",
    });
    expect(arr((await orders(s.b)).json.items)).toHaveLength(1);
    expect(
      arr((await casesOf(admin)).json.items).find((c) => String(c.target?.productId) === productId),
    ).toBeUndefined();
    // nobody else sees S's appeals
    expect(arr((await listAppeals((await player({ pin: false })).b)).json.items)).toEqual([]);
  });
});
