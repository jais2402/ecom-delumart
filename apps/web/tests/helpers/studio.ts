/**
 * Selling-side flows through the routes: a seller with a registered company, a published listing
 * (draft, submit, the signed job run), the Super Admin, and accounts of a chosen age.
 */
import { randomBytes } from "node:crypto";
import { PASSPORT_V1 } from "@delulu/core";
import { expect } from "vitest";
import * as jobsRoute from "../../src/app/api/internal/jobs/run/route";
import * as companyQuote from "../../src/app/api/v1/company/quote/route";
import * as companyRegister from "../../src/app/api/v1/company/register/route";
import * as company from "../../src/app/api/v1/company/route";
import * as concept from "../../src/app/api/v1/passport/concept/route";
import * as quiz from "../../src/app/api/v1/passport/quiz/route";
import * as saves from "../../src/app/api/v1/saves/route";
import * as studioProduct from "../../src/app/api/v1/studio/products/[id]/route";
import * as submit from "../../src/app/api/v1/studio/products/[id]/submit/route";
import * as studioProducts from "../../src/app/api/v1/studio/products/route";
import {
  JOBS_SIGNATURE_HEADER,
  JOBS_TIMESTAMP_HEADER,
  signJobsRequest,
} from "../../src/server/jobs-signature";
import { APP_ORIGIN, type TestApp } from "./app";
import { type Browser, str } from "./browser";
import { player, R } from "./flows";

const RIGHT_ANSWERS = Object.fromEntries(PASSPORT_V1.questions.map((q) => [q.id, q.correctOptionId]));

export const draftBody = (overrides: Record<string, unknown> = {}) => ({
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

/** A store handle of letters only (random hex can trip the text screening). */
export const letterHandle = (): string =>
  `lamps-${Array.from(randomBytes(10), (b) => "bcdfghjklmnpqrstvwxz"[b % 20]).join("")}`;

export interface Seller {
  b: Browser;
  companyId: string;
  warehouseId: string;
  handle: string;
}

/** A player with creator access (the passport) and a registered company, through the routes. */
export async function seller(app: TestApp): Promise<Seller> {
  const { b } = await player({ pin: false });
  const passed = await b.call(quiz.POST, "POST", "/api/v1/passport/quiz", {
    body: { answers: RIGHT_ANSWERS },
  });
  expect(passed.json.passed).toBe(true);
  for (const x of app.products) {
    const saved = await b.call(saves.POST, "POST", "/api/v1/saves", { body: { productId: x.id } });
    expect(saved.status).toBe(200);
  }
  const conceptRes = await b.call(concept.POST, "POST", "/api/v1/passport/concept", {
    body: { concept: "A lamp that is mostly moon and partly nap." },
  });
  expect(conceptRes.status).toBe(200);
  const handle = letterHandle();
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

/** The signed scheduler call (runs screening). */
/** Consecutive seconds for calls within one second: an accepted signature is never accepted again. */
let lastTimestamp = 0;

export async function runJobs(): Promise<number> {
  const body = "{}";
  lastTimestamp = Math.max(Math.floor(Date.now() / 1000), lastTimestamp + 1);
  const timestamp = String(lastTimestamp);
  const key = Buffer.from(process.env.JOBS_SIGNING_KEY ?? "", "hex");
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(JOBS_TIMESTAMP_HEADER, timestamp);
  headers.set(JOBS_SIGNATURE_HEADER, signJobsRequest(key, timestamp, body));
  const res = await jobsRoute.POST(
    new Request(new URL("/api/internal/jobs/run", APP_ORIGIN), { method: "POST", headers, body }),
  );
  return res.status;
}

/** Draft → submit → signed job run: a published listing's id. */
export async function publishedListing(b: Browser, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await b.call(studioProducts.POST, "POST", "/api/v1/studio/products", {
    body: draftBody(overrides),
  });
  expect(created.status).toBe(201);
  const id = str(created.json.product?.id);
  const submitted = await b.call(submit.POST, "POST", `/api/v1/studio/products/${id}/submit`, {
    params: { id },
  });
  expect(submitted.status).toBe(200);
  expect(await runJobs()).toBe(200);
  const got = await b.call(studioProduct.GET, "GET", `/api/v1/studio/products/${id}`, { params: { id } });
  expect(got.json.product?.status).toBe("PUBLISHED");
  return id;
}

/** The user id behind a browser's sign-in session (read as the database owner, for fixtures only). */
export async function userIdOf(app: TestApp, b: Browser): Promise<string> {
  const ids = [...b.jar.values()].filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const { rows } = await app.db.pool.query<{ user_id: string }>(
    "SELECT user_id FROM auth.sessions WHERE id = ANY($1::uuid[]) LIMIT 1",
    [ids],
  );
  return str(rows[0]?.user_id);
}

/** Makes this browser's user the Super Admin (as the database owner, like scripts/dev-setup.ts). */
export async function makeAdmin(app: TestApp, b: Browser): Promise<void> {
  const { rowCount } = await app.db.pool.query(
    "UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1",
    [await userIdOf(app, b)],
  );
  expect(rowCount).toBe(1);
}

/** Dates the account's creation `hours` ago (the fixture stands in for an older sign-up). */
export async function ageAccount(app: TestApp, b: Browser, hours: number): Promise<void> {
  await app.db.pool.query(
    "UPDATE core.user_profile SET created_at = now() - make_interval(hours => $2) WHERE id = $1",
    [await userIdOf(app, b), hours],
  );
}
