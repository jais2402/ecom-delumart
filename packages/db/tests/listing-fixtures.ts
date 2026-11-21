import { screenListing } from "@delulu/core";
import type pg from "pg";
import { createPaymentAttempt } from "../src/checkout";
import { companyQuote, registerCompany } from "../src/company";
import { applyScreening, pendingScreenings, type ScreeningOutcome } from "../src/jobs";
import {
  createDraft,
  type DraftInput,
  type ListingDetail,
  myProduct,
  submitProduct,
} from "../src/listing";
import { type ProductFixture, RUPEE, user } from "./checkout-fixtures";
import type { TestUser } from "./helpers";
import { uuidv7 } from "./helpers";
import { completePassport } from "./selling-fixtures";

export const CATEGORY = "impossible-tech";

/** The catalog categories the studio accepts (written as the owner, like the seed loader). */
export async function ensureCategories(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO core.category (slug, name) VALUES ('impossible-tech', 'Impossible Tech'), ('everyday-magic', 'Everyday Magic')
     ON CONFLICT DO NOTHING`,
  );
}

export interface Creator {
  u: TestUser;
  companyId: string;
  warehouseId: string;
  handle: string;
}

/** A user with creator access (the passport) and a registered company with its starter warehouse. */
export async function creator(pool: pg.Pool, toSave: readonly ProductFixture[]): Promise<Creator> {
  const u = await user(pool);
  await completePassport(pool, u, toSave);
  const handle = `shop-${uuidv7().slice(-10)}`;
  const q = await companyQuote(pool, {
    authSessionId: u.authSessionId,
    handle,
    displayName: "Moon Lamps",
    description: "Lamps that are mostly moon.",
  });
  const a = await createPaymentAttempt(pool, {
    authSessionId: u.authSessionId,
    sessionId: q.sessionId,
    method: "BALANCE",
  });
  const r = await registerCompany(pool, {
    authSessionId: u.authSessionId,
    sessionId: q.sessionId,
    attemptId: a.attemptId,
    idempotencyKey: `k-${uuidv7()}`,
  });
  return { u, companyId: r.companyId, warehouseId: r.warehouseId, handle };
}

let n = 0;
export function draftInput(overrides: Partial<DraftInput> = {}): DraftInput {
  n += 1;
  return {
    name: `Moon Lamp ${n}`,
    hook: "Mostly moon, partly nap.",
    description: "A lamp that is mostly moon and partly nap, for desks that dream.",
    category: CATEGORY,
    templateId: 42,
    altText: "A round lamp glowing like a full moon",
    pricePaise: 500n * RUPEE,
    inventoryMode: "STANDARD_STOCKED",
    quantity: 1,
    ...overrides,
  };
}

/** The screening job's step for one product: screens its pinned revision and applies the verdict. */
export async function screen(
  pool: pg.Pool,
  productId: string,
  verdict?: "OK" | "NEEDS_REVIEW" | "REJECT",
): Promise<ScreeningOutcome> {
  const pending = (await pendingScreenings(pool, 100)).find((p) => p.productId === productId);
  if (!pending) throw new Error("fixture: nothing pending for that product");
  const result = screenListing(pending.fields);
  return applyScreening(pool, {
    productId,
    versionId: pending.versionId,
    verdict: verdict ?? result.verdict,
    reasons: result.reasons,
  });
}

/** Draft, submit, screen OK: a published listing (or one approved and waiting for stock). */
export async function publishListing(
  pool: pg.Pool,
  c: Creator,
  overrides: Partial<DraftInput> = {},
): Promise<ListingDetail> {
  const d = await createDraft(pool, { authSessionId: c.u.authSessionId, draft: draftInput(overrides) });
  await submitProduct(pool, { authSessionId: c.u.authSessionId, productId: d.productId });
  await screen(pool, d.productId, "OK");
  return myProduct(pool, { authSessionId: c.u.authSessionId, productId: d.productId });
}

export const asFixture = (l: ListingDetail): ProductFixture => {
  if (!l.live) throw new Error("fixture: not published");
  return { id: l.productId, versionId: l.live.versionId, pricePaise: l.live.pricePaise };
};
