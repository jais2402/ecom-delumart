import { randomBytes, randomUUID } from "node:crypto";
import { PASSPORT_V1 } from "@delulu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { product } from "../../../packages/db/tests/checkout-fixtures";
import * as companyRoute from "../src/app/api/v1/company/quote/route";
import * as registerRoute from "../src/app/api/v1/company/register/route";
import * as company from "../src/app/api/v1/company/route";
import * as creatorAccess from "../src/app/api/v1/creator-access/route";
import * as concept from "../src/app/api/v1/passport/concept/route";
import * as quiz from "../src/app/api/v1/passport/quiz/route";
import * as passport from "../src/app/api/v1/passport/route";
import * as reliefClaim from "../src/app/api/v1/relief/claim/route";
import * as relief from "../src/app/api/v1/relief/route";
import * as unsave from "../src/app/api/v1/saves/[productId]/route";
import * as saves from "../src/app/api/v1/saves/route";
import * as store from "../src/app/api/v1/stores/[handle]/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { checkout, GOOD_PIN, player, R, signedIn } from "./helpers/flows";

/** Saves, passport, relief and company registration routes (A–E), against a throwaway database. */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.stop();
});

const CRORE = 1_000_000_000n;
const LAKH = 10_000_000n;
const DELIVERY = 100_000n;
const CONCEPT = "A lamp that is mostly moon and partly nap.";
const RIGHT_ANSWERS = Object.fromEntries(PASSPORT_V1.questions.map((q) => [q.id, q.correctOptionId]));

// ------------------------------------------------------------------ calls
const seedIds = (): string[] => app.products.map((p) => p.id);
const getSaves = (b: Browser) => b.call(saves.GET, "GET", "/api/v1/saves");
const save = (b: Browser, productId: string) =>
  b.call(saves.POST, "POST", "/api/v1/saves", { body: { productId } });
const removeSave = (b: Browser, productId: string) =>
  b.call(unsave.DELETE, "DELETE", `/api/v1/saves/${productId}`, { params: { productId } });
const getPassport = (b: Browser) => b.call(passport.GET, "GET", "/api/v1/passport");
const answer = (b: Browser, answers: Record<string, string>) =>
  b.call(quiz.POST, "POST", "/api/v1/passport/quiz", { body: { answers } });
const submitConcept = (b: Browser, text: string) =>
  b.call(concept.POST, "POST", "/api/v1/passport/concept", { body: { concept: text } });
const getAccess = (b: Browser) => b.call(creatorAccess.GET, "GET", "/api/v1/creator-access");
const getRelief = (b: Browser) => b.call(relief.GET, "GET", "/api/v1/relief");
const claim = (b: Browser, productId: string) =>
  b.call(reliefClaim.POST, "POST", "/api/v1/relief/claim", { body: { productId } });
const quote = (b: Browser, body: Record<string, unknown>) =>
  b.call(companyRoute.POST, "POST", "/api/v1/company/quote", { body });
const attempt = (b: Browser, sessionId: string, body: Record<string, unknown> = { method: "BALANCE" }) =>
  b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body,
  });
const register = (b: Browser, sessionId: string, attemptId: string, key: string | boolean = true) =>
  b.call(registerRoute.POST, "POST", "/api/v1/company/register", {
    body: { sessionId, attemptId },
    idempotencyKey: key,
  });
const getCompany = (b: Browser) => b.call(company.GET, "GET", "/api/v1/company");
const editCompany = (b: Browser, body: Record<string, unknown>) =>
  b.call(company.PATCH, "PATCH", "/api/v1/company", { body });
const getStore = (b: Browser, handle: string) =>
  b.call(store.GET, "GET", `/api/v1/stores/${handle}`, { params: { handle }, cookies: false });
const balanceOf = async (b: Browser): Promise<bigint> =>
  BigInt(str((await b.call(R.wallet.GET, "GET", "/api/v1/wallet")).json.balancePaise));
const handle = (): string =>
  `shop-${Array.from(randomBytes(8), (b) => "bcdfghjklmnpqrstvwxz"[b % 20]).join("")}`;

function expectPrivate(res: CallResult): void {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

/** Spends the browser's balance down to `target` with one seed purchase through the routes. */
async function spendTo(b: Browser, target: bigint): Promise<void> {
  const price = (await balanceOf(b)) - target - DELIVERY;
  const p = await product(app.db.pool, { mode: "UNLIMITED_SEED", pricePaise: price });
  const session = await checkout(b, p.id);
  expect(session.status).toBe(201);
  const sessionId = str(session.json.id);
  const a = await attempt(b, sessionId);
  const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(a.json.id) },
    idempotencyKey: true,
  });
  expect(paid.status).toBe(200);
  expect(await balanceOf(b)).toBe(target);
}

/** All three passport steps through the routes. */
async function completePassport(b: Browser): Promise<void> {
  expect((await answer(b, RIGHT_ANSWERS)).json.passed).toBe(true);
  for (const id of seedIds()) expect((await save(b, id)).status).toBe(200);
  expect((await submitConcept(b, CONCEPT)).status).toBe(200);
}

// ------------------------------------------------------------------ tests
describe("access guards", () => {
  const sessionRoutes: [string, (b: Browser) => Promise<CallResult>][] = [
    ["GET saves", getSaves],
    ["POST saves", (b) => save(b, randomUUID())],
    ["DELETE saves", (b) => removeSave(b, randomUUID())],
    ["GET creator-access", getAccess],
    ["GET passport", getPassport],
    ["POST passport/quiz", (b) => answer(b, RIGHT_ANSWERS)],
    ["POST passport/concept", (b) => submitConcept(b, CONCEPT)],
    ["GET relief", getRelief],
    ["POST relief/claim", (b) => claim(b, randomUUID())],
    ["POST company/quote", (b) => quote(b, { handle: handle(), displayName: "Moon Lamps", description: "" })],
    ["POST company/register", (b) => register(b, randomUUID(), randomUUID())],
    ["GET company", getCompany],
    ["PATCH company", (b) => editCompany(b, { description: "x" })],
  ];

  it("401 AUTH_REQUIRED without a sign-in session, private and no-store", async () => {
    const b = new Browser();
    b.csrfToken = str((await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    for (const [name, call] of sessionRoutes) {
      const res = await call(b);
      expect(res.status, name).toBe(401);
      expect(res.json.error?.code, name).toBe("AUTH_REQUIRED");
      expectPrivate(res);
    }
  });

  it("CSRF guards every write; a write needs the session-bound token and the same origin", async () => {
    const { b } = await player({ pin: false });
    const [p] = seedIds();
    const noToken = await b.call(saves.POST, "POST", "/api/v1/saves", {
      body: { productId: p },
      csrf: false,
    });
    expect(noToken.status).toBe(403);
    const foreign = await b.call(company.PATCH, "PATCH", "/api/v1/company", {
      body: { description: "x" },
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    const wrong = await b.call(reliefClaim.POST, "POST", "/api/v1/relief/claim", {
      body: { productId: p },
      csrf: "not-the-token",
    });
    expect(wrong.status).toBe(403);
    expect((await getSaves(b)).json.items).toEqual([]);
  });

  it("the registration pay call needs an Idempotency-Key UUID", async () => {
    const { b } = await player({ pin: false });
    const res = await register(b, randomUUID(), randomUUID(), false);
    expect(res.status).toBe(400);
    expect(res.json.error?.details?.field).toBe("Idempotency-Key");
  });

  it("B can never read A's saves, passport concept or company", async () => {
    const { b: a } = await player({ pin: false });
    const { b: other } = await player({ pin: false });
    await completePassport(a);
    const h = handle();
    const q = await quote(a, { handle: h, displayName: "Moon Lamps", description: "Mostly moon." });
    const sid = str(q.json.sessionId);
    expect((await register(a, sid, str((await attempt(a, sid)).json.id))).status).toBe(201);

    expect((await getSaves(other)).json.items).toEqual([]);
    const theirs = await getPassport(other);
    expect(theirs.json.steps?.concept).toMatchObject({ done: false, text: null });
    expect((await getCompany(other)).json.company).toBeNull();
    const edit = await editCompany(other, { displayName: "Stolen Shop" });
    expect(edit.status).toBe(404);
    // B cannot pay with or attempt A's registration quote either
    const theirAttempt = await attempt(other, sid);
    expect(theirAttempt.status).toBe(404);
    for (const body of [JSON.stringify((await getSaves(other)).json), theirs.text]) {
      expect(body).not.toContain(CONCEPT);
    }
    expect((await getCompany(a)).json.company?.displayName).toBe("Moon Lamps");
  });
});

describe("saves (A)", () => {
  it("A: save, list, unsave; private responses; unpublished products refused", async () => {
    const { b } = await player({ pin: false });
    const [p1, p2] = seedIds();
    const saved = await save(b, str(p1));
    expect(saved.status).toBe(200);
    expectPrivate(saved);
    expect(saved.json).toEqual({ productId: p1, saved: true });
    await save(b, str(p2));
    const list = await getSaves(b);
    expect(list.status).toBe(200);
    expectPrivate(list);
    expect(arr(list.json.items).map((i) => i.productId)).toEqual([p2, p1]);
    expect(arr(list.json.items)[0]).toMatchObject({
      published: true,
      available: true,
      pricePaise: expect.any(String),
    });
    expect((await removeSave(b, str(p2))).json).toEqual({ productId: p2, saved: false });
    expect(arr((await getSaves(b)).json.items).map((i) => i.productId)).toEqual([p1]);
    const missing = await save(b, randomUUID());
    expect(missing.status).toBe(409);
    expect(missing.json.error?.code).toBe("PRODUCT_UNAVAILABLE");
  });

  it("A: saving needs a finished onboarding", async () => {
    const b = await signedIn();
    const res = await save(b, str(seedIds()[0]));
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("ONBOARDING_REQUIRED");
  });
});

describe("passport (B, US-05)", () => {
  it("US-05: the quiz is graded on the server; wrong answers name the questions, never the right options", async () => {
    const { b } = await player({ pin: false });
    const shown = await getPassport(b);
    expect(shown.status).toBe(200);
    expect(arr(shown.json.quiz?.questions)).toHaveLength(3);
    expect(shown.text).not.toContain("correct");

    const q1 = PASSPORT_V1.questions[0];
    if (!q1) throw new Error("fixture");
    const wrongOption = q1.options.find((o) => o.id !== q1.correctOptionId)?.id ?? "";
    const failed = await answer(b, { ...RIGHT_ANSWERS, [q1.id]: wrongOption });
    expect(failed.status).toBe(200);
    expect(failed.json).toMatchObject({ passed: false, wrong: [q1.id] });
    expect(failed.text).not.toContain(q1.correctOptionId);
    expect(failed.json.passport?.steps?.quiz).toMatchObject({ done: false, failedAttempts: 1 });
    const passed = await answer(b, RIGHT_ANSWERS);
    expect(passed.json).toMatchObject({
      passed: true,
      wrong: [],
      passport: { steps: { quiz: { done: true } } },
    });
  });

  it("US-05: a concept that fails screening is VALIDATION_FAILED with field reasons and stores nothing", async () => {
    const { b } = await player({ pin: false });
    for (const [text, code] of [
      ["Moon lamp, pay via upi to my number please", "PAYMENT"],
      ["Visit moonlamp.shop for the full story", "LINK"],
      ["The official lamp of the moon, quite round", "OFFICIAL"],
      ["too short", "TOO_SHORT"],
      ["x".repeat(281), "TOO_LONG"],
    ] as const) {
      const res = await submitConcept(b, text);
      expect(res.status, text).toBe(422);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
      expect(arr(res.json.error?.details?.reasons)).toContainEqual({ field: "concept", code });
      expect(res.text).not.toContain(text);
    }
    expect((await getPassport(b)).json.steps?.concept).toMatchObject({ done: false, text: null });
    const ok = await submitConcept(b, CONCEPT);
    expect(ok.status).toBe(200);
    expect(ok.json.steps?.concept).toMatchObject({ done: true, text: CONCEPT });
  });
});

describe("relief (C)", () => {
  it("C: not eligible at ₹100 crore; below ₹10 lakh one claim per UTC day with a never-saved product", async () => {
    const { b } = await player({ pin: false });
    const status = await getRelief(b);
    expect(status.status).toBe(200);
    expectPrivate(status);
    expect(status.json).toMatchObject({
      eligible: false,
      reason: "BALANCE_TOO_HIGH",
      claimsUsed: 0,
      claimsMax: 7,
    });
    const [p1, p2] = seedIds();
    const refused = await claim(b, str(p1));
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe("RELIEF_NOT_ELIGIBLE");

    await spendTo(b, 5n * LAKH);
    expect((await getRelief(b)).json).toMatchObject({ eligible: true, reason: null });
    await save(b, str(p1));
    const savedBefore = await claim(b, str(p1));
    expect(savedBefore.status).toBe(409);
    expect(savedBefore.json.error?.code).toBe("CONFLICT");
    const ok = await claim(b, str(p2));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      productId: p2,
      grantedPaise: (10n * LAKH).toString(),
      balancePaise: (15n * LAKH).toString(),
      claimsUsed: 1,
      claimsRemaining: 6,
      eligible: false,
      reason: "CLAIMED_TODAY",
    });
    expect(await balanceOf(b)).toBe(15n * LAKH);
    const again = await claim(b, str(seedIds()[2]));
    expect(again.json.error?.code).toBe("RELIEF_NOT_ELIGIBLE");
  });
});

describe("company (E)", () => {
  it("US-18: quote refusals name the field: handle, display name, description, screening", async () => {
    const { b } = await player({ pin: false });
    await completePassport(b);
    for (const [body, field, code] of [
      [{ handle: "ab", displayName: "Moon Lamps", description: "" }, "handle", "TOO_SHORT"],
      [{ handle: "admin", displayName: "Moon Lamps", description: "" }, "handle", "RESERVED"],
      [{ handle: "moon--lamps", displayName: "Moon Lamps", description: "" }, "handle", "DOUBLE_HYPHEN"],
      [{ handle: handle(), displayName: "ab", description: "" }, "displayName", "TOO_SHORT"],
      [
        { handle: handle(), displayName: "Moon Lamps", description: "x".repeat(281) },
        "description",
        "TOO_LONG",
      ],
      [{ handle: handle(), displayName: "Official Moon Lamps", description: "" }, "displayName", "OFFICIAL"],
      [
        { handle: handle(), displayName: "Moon Lamps", description: "pay me on paytm" },
        "description",
        "PAYMENT",
      ],
      [{ handle: "moon-paytm", displayName: "Moon Lamps", description: "" }, "handle", "PAYMENT"],
    ] as const) {
      const res = await quote(b, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(arr(res.json.error?.details?.reasons)).toContainEqual({ field, code });
    }
    expect((await getCompany(b)).json.company).toBeNull();
  });

  it("US-18: needs creator access; a handle held by someone else's quote is HANDLE_RESERVED", async () => {
    const { b: plain } = await player({ pin: false });
    const locked = await quote(plain, { handle: handle(), displayName: "Moon Lamps", description: "" });
    expect(locked.status).toBe(403);
    expect(locked.json.error?.code).toBe("CREATOR_LOCKED");
    const { b: a } = await player({ pin: false });
    const { b: c } = await player({ pin: false });
    await completePassport(a);
    await completePassport(c);
    const h = handle();
    expect((await quote(a, { handle: h, displayName: "Moon Lamps", description: "" })).status).toBe(201);
    const held = await quote(c, { handle: h, displayName: "Moon Lamps", description: "" });
    expect(held.status).toBe(409);
    expect(held.json.error?.code).toBe("HANDLE_RESERVED");
  });

  it("US-18: the existing attempt and PIN routes pay a COMPANY_REGISTRATION quote by card; a replay is the same company", async () => {
    const { b, cardId } = await player();
    await completePassport(b);
    const q = await quote(b, { handle: handle(), displayName: "Moon Lamps", description: "" });
    const sid = str(q.json.sessionId);
    const a = await attempt(b, sid, { method: "CARD", cardId });
    expect(a.status).toBe(201);
    expect(a.json.authenticated).toBe(false);
    const attemptId = str(a.json.id);
    const pending = await register(b, sid, attemptId);
    expect(pending.status).toBe(409);
    expect(pending.json.error?.code).toBe("PAYMENT_PENDING");
    const pin = await b.call(R.attemptPin.POST, "POST", `/api/v1/attempts/${attemptId}/pin`, {
      params: { id: attemptId },
      body: { pin: GOOD_PIN },
    });
    expect(pin.status).toBe(200);
    const key = randomUUID();
    const done = await register(b, sid, attemptId, key);
    expect(done.status).toBe(201);
    const replay = await register(b, sid, attemptId, key);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ...done.json, replayed: true });
    const second = await register(b, sid, attemptId);
    expect(second.status).toBe(409);
    expect(await balanceOf(b)).toBe(100n * CRORE - 5n * LAKH);
  });

  it("E: the owner edits the store; the edit is screened; the handle cannot be sent", async () => {
    const { b } = await player({ pin: false });
    await completePassport(b);
    const h = handle();
    const q = await quote(b, { handle: h, displayName: "Moon Lamps", description: "" });
    const sid = str(q.json.sessionId);
    await register(b, sid, str((await attempt(b, sid)).json.id));
    const edited = await editCompany(b, { displayName: "  Moon Lamps Two  ", description: "Now rounder." });
    expect(edited.status).toBe(200);
    expectPrivate(edited);
    expect(edited.json.company).toMatchObject({
      handle: h,
      displayName: "Moon Lamps Two",
      description: "Now rounder.",
    });
    const screened = await editCompany(b, { description: "dm me on whatsapp" });
    expect(screened.status).toBe(422);
    expect(arr(screened.json.error?.details?.reasons)).toContainEqual({
      field: "description",
      code: "WATCH",
    });
    const withHandle = await editCompany(b, { handle: "new-handle" });
    expect(withHandle.status).toBe(400);
    expect((await getCompany(b)).json.company?.handle).toBe(h);
  });

  it("E: the public store route is cacheable, reads no session and names no owner", async () => {
    const unknown = await getStore(new Browser(), "no-such-store");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const odd = await getStore(new Browser(), "Not A Handle!");
    expect(odd.status).toBe(404);
  });
});

describe("journey", () => {
  it("US-05 US-18: new user → passport → creator access with ₹100 crore intact → quote → BALANCE → register → SOLO company with a 100-slot starter warehouse at ₹99.95 crore → public store", async () => {
    const { b } = await player({ pin: false });
    expect(await balanceOf(b)).toBe(100n * CRORE);
    const before = await getAccess(b);
    expect(before.status).toBe(200);
    expectPrivate(before);
    expect(before.json).toMatchObject({
      unlocked: false,
      source: null,
      routes: { spend: { reached: false } },
    });

    // the passport: quiz, three saves, concept
    expect((await answer(b, RIGHT_ANSWERS)).json.passed).toBe(true);
    for (const id of seedIds()) await save(b, id);
    const progress = await getPassport(b);
    expect(progress.json.steps).toMatchObject({
      quiz: { done: true },
      saves: { done: true, count: 3, required: 3 },
    });
    expect(progress.json.completedAt).toBeNull();
    const finished = await submitConcept(b, CONCEPT);
    expect(finished.json.completedAt).toEqual(expect.any(String));

    const access = await getAccess(b);
    expect(access.json).toMatchObject({
      unlocked: true,
      source: "ACHIEVEMENT",
      ruleVersion: "passport_v1",
      routes: {
        spend: { balancePaise: (100n * CRORE).toString(), thresholdPaise: CRORE.toString(), reached: false },
        passport: { completedAt: expect.any(String) },
      },
    });
    expect(await balanceOf(b)).toBe(100n * CRORE);

    // company registration
    const h = handle();
    const q = await quote(b, {
      handle: h,
      displayName: "Moon Lamps",
      description: "Lamps that are mostly moon.",
    });
    expect(q.status).toBe(201);
    expectPrivate(q);
    expect(q.json).toMatchObject({
      handle: h,
      displayName: "Moon Lamps",
      feePaise: (5n * LAKH).toString(),
      sponsorshipPaise: "0",
      payablePaise: (5n * LAKH).toString(),
      balancePaise: (100n * CRORE).toString(),
      balanceAfterPaise: (100n * CRORE - 5n * LAKH).toString(),
      sufficient: true,
    });
    const sid = str(q.json.sessionId);
    const a = await attempt(b, sid);
    expect(a.status).toBe(201);
    expect(a.json.authenticated).toBe(true);
    const reg = await register(b, sid, str(a.json.id));
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({
      handle: h,
      tier: "SOLO",
      feePaise: (5n * LAKH).toString(),
      paidPaise: (5n * LAKH).toString(),
      sponsorshipPaise: "0",
      balanceAfterPaise: (100n * CRORE - 5n * LAKH).toString(),
      replayed: false,
    });

    const mine = await getCompany(b);
    expect(mine.status).toBe(200);
    expectPrivate(mine);
    expect(mine.json.company).toMatchObject({
      handle: h,
      displayName: "Moon Lamps",
      description: "Lamps that are mostly moon.",
      tier: "SOLO",
      registeredAt: expect.any(String),
      warehouses: { count: 1, capacity: 100, used: 0, starter: { capacity: 100, used: 0 } },
    });
    expect(await balanceOf(b)).toBe((9995n * CRORE) / 100n); // ₹99.95 crore
    // still creator by the passport, with no spending route recorded
    expect((await getAccess(b)).json).toMatchObject({
      source: "ACHIEVEMENT",
      routes: { spend: { reached: false } },
    });

    const pub = await getStore(new Browser(), h);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(pub.json).toEqual({
      handle: h,
      displayName: "Moon Lamps",
      description: "Lamps that are mostly moon.",
      tier: "SOLO",
    });
    expect(pub.headers.get("set-cookie")).toBeNull();
  });
});
