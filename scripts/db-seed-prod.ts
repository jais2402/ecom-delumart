/**
 * Seeds the platform's own 60-product catalogue (apps/web/src/data/seed-catalog.ts) into a deployed
 * database. Runs on the OWNER'S OWN COMPUTER with the owner connection, like db:migrate:prod. It is
 * an upsert in one transaction: running it again creates nothing twice. Nothing secret is printed.
 */
import { CATEGORIES, SEED_PRODUCTS } from "../apps/web/src/data/seed-catalog.ts";
import { seedCatalog } from "../packages/db/src/index.ts";
import {
  ask,
  describeTarget,
  explain,
  fail,
  hasFlag,
  ownerPool,
  ownerTarget,
  say,
} from "./lib/owner-terminal.ts";

async function main(): Promise<void> {
  const { url, target } = await ownerTarget({ requireConfirm: true });
  say(`db:seed:prod: ${describeTarget(target)}`);
  say(
    `This adds ${CATEGORIES.length} categories and ${SEED_PRODUCTS.length} platform products (existing ones are kept).`,
  );
  if (!hasFlag("--yes")) {
    const typed = await ask("Type the project ref again to go ahead: ");
    if (typed !== (target.loopback ? "local" : target.projectRef))
      fail("Not confirmed. Nothing was changed.");
  }
  const pool = ownerPool(url, target);
  try {
    const seeded = await seedCatalog(pool, SEED_PRODUCTS, CATEGORIES);
    say(
      `Done: ${seeded.categories} categories, ${seeded.productsCreated} products created, ` +
        `${seeded.versionsCreated} versions created (of ${SEED_PRODUCTS.length}).`,
    );
  } catch (error) {
    say(`db:seed:prod failed: ${explain(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  say(`db:seed:prod failed: ${explain(error)}`);
  process.exit(1);
});
