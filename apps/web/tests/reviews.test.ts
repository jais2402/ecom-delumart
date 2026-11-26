import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as adminHide from "../src/app/api/v1/admin/reviews/[id]/hide/route";
import * as adminRestore from "../src/app/api/v1/admin/reviews/[id]/restore/route";
import * as adminList from "../src/app/api/v1/admin/reviews/route";
import * as mine from "../src/app/api/v1/me/reviews/[productId]/route";
import * as review from "../src/app/api/v1/products/[id]/review/route";
import * as reviews from "../src/app/api/v1/products/[id]/reviews/route";
import * as summaries from "../src/app/api/v1/review-summaries/route";
import { settleTracking } from "../src/server/analytics";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { checkout, player, R } from "./helpers/flows";
import { aMinuteLater, makeAdmin, userIdOf } from "./helpers/studio";

/** Ratings and reviews through the routes (docs/decisions.md #14, migration 0078). */
let app: TestApp;
let productId = "";
let otherProductId = "";

beforeAll(async () => {
  app = await startTestApp();
  productId = str(app.products[0]?.id);
  otherProductId = str(app.products[1]?.id);
}, 120_000);

afterAll(async () => {
  await app.stop();
});

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

async function buy(b: Browser, id: string): Promise<void> {
  const s = await checkout(b, id);
  expect(s.status).toBe(201);
  const sessionId = str(s.json.id);
  const attempt = await b.call(R.attempts.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/attempts`, {
    params: { id: sessionId },
    body: { method: "BALANCE" },
  });
  expect(attempt.status).toBe(201);
  const paid = await b.call(R.pay.POST, "POST", `/api/v1/checkout-sessions/${sessionId}/pay`, {
    params: { id: sessionId },
    body: { attemptId: str(attempt.json.id) },
    idempotencyKey: true,
  });
  expect(paid.status).toBe(200);
}

/** A signed-in player who bought the product, its purchase minute over. */
async function owner(id: string = productId): Promise<Browser> {
  const { b } = await player({ pin: false });
  await buy(b, id);
  await aMinuteLater(app);
  return b;
}

const put = (b: Browser, body: unknown, id: string = productId, extra = {}) =>
  b.call(review.PUT, "PUT", `/api/v1/products/${id}/review`, { params: { id }, body, ...extra });
const del = (b: Browser, id: string = productId, extra = {}) =>
  b.call(review.DELETE, "DELETE", `/api/v1/products/${id}/review`, { params: { id }, ...extra });
const list = (b: Browser, id: string = productId, page?: string) =>
  b.call(reviews.GET, "GET", `/api/v1/products/${id}/reviews${page ? `?page=${page}` : ""}`, {
    params: { id },
  });
const my = (b: Browser, id: string = productId) =>
  b.call(mine.GET, "GET", `/api/v1/me/reviews/${id}`, { params: { productId: id } });

function expectError(res: CallResult, status: number, code: string): void {
  expect(res.status, res.text).toBe(status);
  expect(res.json.error?.code).toBe(code);
}

describe("public reviews (GET /api/v1/products/{id}/reviews)", () => {
  it("REV-3: public and cacheable, the same for everyone, with the summary, bars and page", async () => {
    const anon = new Browser();
    const res = await list(anon);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(Object.keys(res.json).sort()).toEqual(
      [
        "averageTenths",
        "count",
        "distribution",
        "items",
        "page",
        "pageSize",
        "productId",
        "ratingSum",
        "totalPages",
      ].sort(),
    );
    expect(res.json.pageSize).toBe(10);
    // a signed-in owner gets exactly the public answer: no "your review" in a public response
    const b = await owner();
    expect((await put(b, { rating: 5, title: "Lovely" })).status).toBe(200);
    await aMinuteLater(app);
    const signedIn = await list(b);
    const signedOut = await list(new Browser());
    expect(signedIn.text).toBe(signedOut.text);
    expect(signedIn.headers.get("cache-control")).toBe(PUBLIC_CACHE);
  });

  it("REV-3: an id that is not a uuid, an unknown product or a bad page is refused without caching", async () => {
    const anon = new Browser();
    const bad = await list(anon, "not-a-uuid");
    expectError(bad, 404, "NOT_FOUND");
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expectError(await list(anon, "0192f6a0-0000-7000-8000-0000000000ff"), 404, "NOT_FOUND");
    expectError(await list(anon, productId, "0"), 400, "VALIDATION_FAILED");
    expectError(await list(anon, productId, "abc"), 400, "VALIDATION_FAILED");
  });

  it("REV-5: the public answer names no user id, email, order id or time; the author is a handle or none", async () => {
    const b = await owner(otherProductId);
    expect((await put(b, { rating: 3, title: "Mid", body: "Fine." }, otherProductId)).status).toBe(200);
    await aMinuteLater(app);
    const res = await list(new Browser(), otherProductId);
    const userId = await userIdOf(app, b);
    expect(res.text).not.toContain(userId);
    expect(res.text).not.toMatch(/@|userId|orderId|reviewId|createdAt|\d{2}:\d{2}/);
    const item = arr(res.json.items).find((i) => String(i.title) === "Mid");
    expect(item).toMatchObject({
      rating: 3,
      body: "Fine.",
      author: null,
      verifiedOwner: true,
      edited: false,
    });
    expect(str(item?.createdOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("summaries (GET /api/v1/review-summaries)", () => {
  it("REV-3: up to 100 ids, public and cacheable; bad ids or too many are refused", async () => {
    const anon = new Browser();
    const ok = await anon.call(
      summaries.GET,
      "GET",
      `/api/v1/review-summaries?productIds=${productId},${otherProductId}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    expect(
      arr(ok.json.items)
        .map((i) => i.productId)
        .sort(),
    ).toEqual([productId, otherProductId].sort());
    for (const i of arr(ok.json.items))
      expect(Object.keys(i).sort()).toEqual(["averageTenths", "count", "productId", "ratingSum"]);
    expectError(
      await anon.call(summaries.GET, "GET", "/api/v1/review-summaries?productIds=nope"),
      400,
      "VALIDATION_FAILED",
    );
    expectError(await anon.call(summaries.GET, "GET", "/api/v1/review-summaries"), 400, "VALIDATION_FAILED");
    const many = Array.from(
      { length: 101 },
      (_, i) => `0192f6a0-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    expectError(
      await anon.call(summaries.GET, "GET", `/api/v1/review-summaries?productIds=${many.join(",")}`),
      400,
      "VALIDATION_FAILED",
    );
  });
});

describe("writing a review (PUT/DELETE /api/v1/products/{id}/review)", () => {
  it("REV-1: needs a session (401), the CSRF token and the same origin (403); every answer is private", async () => {
    const anon = new Browser();
    const noSession = await put(anon, { rating: 5 });
    expectError(noSession, 403, "FORBIDDEN"); // no CSRF cookie at all: refused before the session check
    const b = await owner();
    expectError(await put(b, { rating: 5 }, productId, { csrf: false }), 403, "FORBIDDEN");
    expectError(await put(b, { rating: 5 }, productId, { origin: "https://evil.example" }), 403, "FORBIDDEN");
    expectError(await del(b, productId, { csrf: "forged" }), 403, "FORBIDDEN");
    const signedOut = new Browser();
    signedOut.csrfToken = str((await signedOut.call(R.csrf.GET, "GET", "/api/v1/auth/csrf")).json.csrfToken);
    const res = await put(signedOut, { rating: 5 });
    expectError(res, 401, "AUTH_REQUIRED");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expectError(await my(signedOut), 401, "AUTH_REQUIRED");
  });

  it("REV-1: an owner writes, edits and deletes; the review is public only after the purchase minute", async () => {
    const { b } = await player({ pin: false });
    await buy(b, otherProductId);
    const first = await put(b, { rating: 2, title: "Meh" }, otherProductId);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.json).toMatchObject({
      changed: true,
      review: { rating: 2, title: "Meh", edited: false, public: false },
    });
    const before = await list(new Browser(), otherProductId);
    expect(arr(before.json.items).some((i) => String(i.title) === "Meh")).toBe(false);
    await aMinuteLater(app);
    const edited = await put(b, { rating: 4, title: "Grew on me", body: "It glows." }, otherProductId);
    expect(edited.json).toMatchObject({ changed: true, review: { rating: 4, edited: true, public: true } });
    const again = await put(b, { rating: 4, title: "Grew on me", body: "It glows." }, otherProductId);
    expect(again.json.changed).toBe(false);
    const own = await my(b, otherProductId);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect(own.json).toMatchObject({
      eligible: true,
      reason: null,
      review: { rating: 4, title: "Grew on me" },
    });
    expect(
      arr((await list(new Browser(), otherProductId)).json.items).some(
        (i) => String(i.title) === "Grew on me",
      ),
    ).toBe(true);
    const gone = await del(b, otherProductId);
    expect(gone.status).toBe(200);
    expect(gone.json).toEqual({ productId: otherProductId, deleted: true });
    expect((await del(b, otherProductId)).status).toBe(200);
    expect(
      arr((await list(new Browser(), otherProductId)).json.items).some(
        (i) => String(i.title) === "Grew on me",
      ),
    ).toBe(false);
    expect((await my(b, otherProductId)).json.review).toBeNull();
  });

  it("REV-1: a player who does not own the product is REVIEW_NOT_ALLOWED; never having reviewed, delete is REVIEW_NOT_FOUND", async () => {
    const { b } = await player({ pin: false });
    expectError(await put(b, { rating: 5 }), 403, "REVIEW_NOT_ALLOWED");
    expectError(await del(b), 404, "REVIEW_NOT_FOUND");
    expect((await my(b)).json).toMatchObject({ eligible: false, reason: "NOT_OWNER", review: null });
    expectError(await put(b, { rating: 5 }, "not-a-uuid"), 404, "NOT_FOUND");
  });

  it("REV-2: bad fields are REVIEW_INVALID with field reasons and never echo the text", async () => {
    const b = await owner();
    const cases: [unknown, string][] = [
      [{}, "rating:REQUIRED"],
      [{ rating: 0 }, "rating:OUT_OF_RANGE"],
      [{ rating: 4.5 }, "rating:OUT_OF_RANGE"],
      [{ rating: 4, title: "t".repeat(81) }, "title:TOO_LONG"],
      [{ rating: 4, body: "b".repeat(1001) }, "body:TOO_LONG"],
      [{ rating: 4, body: "find me at www.moonlamp-secret.example" }, "body:LINK"],
      [{ rating: 4, title: "ring 98765 43210" }, "title:PHONE"],
      [{ rating: 4, body: "card 4111 1111 1111 1111 works" }, "body:PHONE"],
      [{ rating: 4, body: "mail moon.secret@example.test" }, "body:EMAIL"],
    ];
    for (const [body, reason] of cases) {
      const res = await put(b, body);
      expectError(res, 422, "REVIEW_INVALID");
      const reasons = arr(res.json.error?.details?.reasons).map(
        (r) => `${String(r.field)}:${String(r.code)}`,
      );
      expect(reasons, JSON.stringify(body)).toContain(reason);
      expect(res.text).not.toMatch(/secret|4111|98765/);
    }
    // an unknown field or a wrong type is a malformed request
    expectError(await put(b, { rating: 4, userId: "x" }), 400, "VALIDATION_FAILED");
    expectError(await put(b, { rating: "4" }), 400, "VALIDATION_FAILED");
  });

  it("REV-2: ten review writes an hour per account, then RATE_LIMITED", async () => {
    const b = await owner();
    for (let i = 1; i <= 10; i++) expect((await put(b, { rating: (i % 5) + 1 })).status).toBe(200);
    const res = await put(b, { rating: 3 });
    expectError(res, 429, "RATE_LIMITED");
    expect(res.json.error?.retryable).toBe(true);
    expectError(await del(b), 429, "RATE_LIMITED");
  });

  it("REV-5: a successful write records review_submitted with no props; a repeat records nothing more", async () => {
    const count = async () =>
      Number(
        (
          await app.db.pool.query<{ n: string }>(
            "SELECT count(*) AS n FROM analytics.event WHERE name = 'review_submitted'",
          )
        ).rows[0]?.n,
      );
    await settleTracking();
    const before = await count();
    const b = await owner();
    await put(b, { rating: 5, title: "Analytics" });
    await put(b, { rating: 5, title: "Analytics" });
    await settleTracking();
    expect(await count()).toBe(before + 1);
    const { rows } = await app.db.pool.query<{ props: unknown; visitor_key: unknown }>(
      "SELECT props, visitor_key FROM analytics.event WHERE name = 'review_submitted'",
    );
    for (const r of rows) expect(r).toEqual({ props: {}, visitor_key: null });
  });
});

describe("moderation (Super Admin)", () => {
  it("REV-4: only the Super Admin lists, hides and restores; hidden reviews leave the public answer", async () => {
    const author = await owner(otherProductId);
    expect((await put(author, { rating: 1, title: "Moderate me" }, otherProductId)).status).toBe(200);
    const notAdmin = (await player({ pin: false })).b;
    expectError(await notAdmin.call(adminList.GET, "GET", "/api/v1/admin/reviews"), 403, "FORBIDDEN");
    const { b: admin } = await player({ pin: false });
    await makeAdmin(app, admin);
    const page = await admin.call(adminList.GET, "GET", "/api/v1/admin/reviews?filter=ALL");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    const item = arr(page.json.items).find((i) => String(i.title) === "Moderate me");
    const id = str(item?.reviewId);
    expect(page.text).not.toContain(await userIdOf(app, author));
    const hide = (b: Browser, reason: string, extra = {}) =>
      b.call(adminHide.POST, "POST", `/api/v1/admin/reviews/${id}/hide`, {
        params: { id },
        body: { reason },
        ...extra,
      });
    expectError(await hide(notAdmin, "Abusive language"), 403, "FORBIDDEN");
    expectError(await hide(admin, "Abusive language", { csrf: false }), 403, "FORBIDDEN");
    expectError(await hide(admin, "no"), 422, "VALIDATION_FAILED");
    const hidden = await hide(admin, "Abusive language");
    expect(hidden.status).toBe(200);
    expect(hidden.json).toEqual({ reviewId: id, hidden: true });
    expectError(await hide(admin, "Abusive language"), 409, "CONFLICT");
    expect(
      arr((await list(new Browser(), otherProductId)).json.items).some(
        (i) => String(i.title) === "Moderate me",
      ),
    ).toBe(false);
    expect((await my(author, otherProductId)).json.review).toMatchObject({
      hidden: true,
      hiddenReason: "Abusive language",
    });
    const hiddenOnly = await admin.call(adminList.GET, "GET", "/api/v1/admin/reviews?filter=HIDDEN");
    expect(arr(hiddenOnly.json.items).every((i) => (i.hidden as unknown) === true)).toBe(true);
    const restored = await admin.call(adminRestore.POST, "POST", `/api/v1/admin/reviews/${id}/restore`, {
      params: { id },
      body: { reason: "Reviewed again, fine" },
    });
    expect(restored.json).toEqual({ reviewId: id, hidden: false });
    expect(
      arr((await list(new Browser(), otherProductId)).json.items).some(
        (i) => String(i.title) === "Moderate me",
      ),
    ).toBe(true);
    const unknown = "0192f6a0-0000-4000-8000-0000000000ff";
    expectError(
      await admin.call(adminHide.POST, "POST", `/api/v1/admin/reviews/${unknown}/hide`, {
        params: { id: unknown },
        body: { reason: "Unknown review" },
      }),
      404,
      "REVIEW_NOT_FOUND",
    );
    expectError(
      await admin.call(adminList.GET, "GET", "/api/v1/admin/reviews?filter=SOME"),
      400,
      "VALIDATION_FAILED",
    );
    await settleTracking();
    const { rows } = await app.db.pool.query<{ props: unknown }>(
      "SELECT props FROM analytics.event WHERE name = 'review_hidden'",
    );
    expect(rows).toEqual([{ props: {} }]);
  });
});
