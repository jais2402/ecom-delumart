import { PASSPORT_RULE_VERSION } from "@delulu/core";
import type pg from "pg";
import { recordPassportQuiz, saveProduct, submitPassportConcept } from "../src/passport";
import {
  CRORE,
  checkout,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  STANDARD_DELIVERY,
  standard,
  wallet,
} from "./checkout-fixtures";
import type { TestUser } from "./helpers";

export const CONCEPT = "A lamp that is mostly moon and partly nap.";
export const STARTING = 100n * CRORE;

/** Published seed products (unlimited stock) to save or buy. */
export async function published(
  pool: pg.Pool,
  n: number,
  pricePaise = 100n * RUPEE,
): Promise<ProductFixture[]> {
  const out: ProductFixture[] = [];
  for (let i = 0; i < n; i++) out.push(await product(pool, { mode: "UNLIMITED_SEED", pricePaise }));
  return out;
}

/**
 * Spends the user's balance down to exactly `target` paise with one seed purchase at Standard
 * delivery (price = balance - target - delivery fee; whole rupees, at least ₹100).
 */
export async function spendTo(pool: pg.Pool, u: TestUser, target: bigint) {
  const balance = await wallet(pool, u.ledgerAccountId);
  const price = balance - target - STANDARD_DELIVERY;
  if (price < 100n * RUPEE || price % RUPEE !== 0n) throw new Error(`fixture: cannot spend to ${target}`);
  const p = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: price });
  const receipt = await payFor(pool, u, await checkout(pool, u, [p], standard("SEED")));
  if ((await wallet(pool, u.ledgerAccountId)) !== target) throw new Error("fixture: spend-down missed");
  return receipt;
}

export const passQuiz = (pool: pg.Pool, u: TestUser) =>
  recordPassportQuiz(pool, {
    authSessionId: u.authSessionId,
    passed: true,
    ruleVersion: PASSPORT_RULE_VERSION,
  });

/** All three passport steps through the commands, saving the given products. */
export async function completePassport(pool: pg.Pool, u: TestUser, toSave: readonly ProductFixture[]) {
  await passQuiz(pool, u);
  for (const p of toSave) await saveProduct(pool, { authSessionId: u.authSessionId, productId: p.id });
  return submitPassportConcept(pool, { authSessionId: u.authSessionId, concept: CONCEPT, screening: "OK" });
}
