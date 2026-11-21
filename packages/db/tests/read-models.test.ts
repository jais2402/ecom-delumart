import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  myCollection,
  myOrder,
  myOrders,
  myStatement,
  myWallet,
  ownsProducts,
  revealCardNumber,
} from "../src/account";
import { setCardPin } from "../src/card";
import { catalogProduct, catalogProducts } from "../src/catalog";
import { SINK_ACCOUNT_ID } from "../src/provision";
import { withTransaction } from "../src/transaction";
import {
  CRORE,
  checkout,
  codeOf,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  type Seller,
  seller,
  standard,
  user,
  wallet,
} from "./checkout-fixtures";
import { createTestDatabase, inTx, stateOf, type TestDatabase, type TestUser, uuidv7 } from "./helpers";

describe("read models for the web app (actor-scoped, no other user's data)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: TestUser;
  let b: TestUser;
  let s: Seller;
  let seedP: ProductFixture;
  let stocked: ProductFixture;
  let soldOut: ProductFixture;
  let draftId: string;
  let hiddenId: string;
  let aOrder: string;
  let bOrder: string;

  /** A product in a non-public status, with a version, written as the owner. */
  async function unpublished(status: "DRAFT" | "HIDDEN"): Promise<string> {
    const id = uuidv7();
    const v = uuidv7();
    await inTx(pool, async (c) => {
      await c.query(
        `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode, available_units)
         VALUES ($1, $2, 'USER', $3, 'gadgets', 'STANDARD_STOCKED', 0)`,
        [id, s.companyId, status],
      );
      await c.query(
        `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
         VALUES ($1, $2, 1, 'Secret Draft', 'Not for sale yet, not at all.', 'A draft', 1, 10000)`,
        [v, id],
      );
      await c.query("UPDATE core.product SET current_version_id = $2 WHERE id = $1", [id, v]);
    });
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    a = await user(pool);
    b = await user(pool);
    s = await seller(pool);
    seedP = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 1_000n * RUPEE, zap: true });
    stocked = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 2_000n * RUPEE,
      units: 2,
    });
    soldOut = await product(pool, {
      seller: s,
      mode: "STANDARD_STOCKED",
      pricePaise: 3_000n * RUPEE,
      units: 1,
    });
    draftId = await unpublished("DRAFT");
    hiddenId = await unpublished("HIDDEN");
    aOrder = (await payFor(pool, a, await checkout(pool, a, [seedP, stocked], standard("SEED", s))))
      .orderGroupId;
    bOrder = (await payFor(pool, b, await checkout(pool, b, [seedP, soldOut], standard("SEED", s))))
      .orderGroupId;
  });
  afterAll(async () => {
    await db.drop();
  });

  const PERSONAL = /fingerprint|birthdate|address|phone|email|buyer_?user|pin_?hash/i;

  describe("my_wallet", () => {
    it("returns the actor's balance, bank alias, DeluluPay id and card summary, never the full card number", async () => {
      const w = await myWallet(pool, a);
      expect(w?.balancePaise).toBe(await wallet(pool, a.ledgerAccountId));
      expect(w?.cardId).toBe(a.cardId);
      expect(w?.cardStatus).toBe("ACTIVE");
      expect(w?.cardLastFour).toBe(a.cardNumber.slice(-4));
      expect(w?.pinSet).toBe(false);
      expect(w?.creatorUnlocked).toBe(false);
      const bank = await pool.query<{ alias: string; upi_style_id: string }>(
        "SELECT alias, upi_style_id FROM core.bank_account WHERE id = $1",
        [a.bankAccountId],
      );
      expect(w?.bankAlias).toBe(bank.rows[0]?.alias);
      expect(w?.delulupayId).toBe(bank.rows[0]?.upi_style_id);
      expect(JSON.stringify(w, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
        a.cardNumber,
      );
      await setCardPin(pool, {
        authSessionId: b.authSessionId,
        cardId: b.cardId,
        pinMac: Buffer.alloc(32, 9),
      });
      expect((await myWallet(pool, b))?.pinSet).toBe(true);
      expect((await myWallet(pool, a))?.pinSet).toBe(false);
    });

    it("user A gets only A's wallet; without a session it is FORBIDDEN; before provisioning it is null", async () => {
      const wa = await myWallet(pool, a);
      const wb = await myWallet(pool, b);
      expect(wa?.cardId).not.toBe(wb?.cardId);
      expect(await codeOf(myWallet(pool, { authSessionId: uuidv7() }))).toBe("FORBIDDEN");
      const { sessionFor } = await import("./helpers");
      expect(await myWallet(pool, { authSessionId: await sessionFor(pool, uuidv7()) })).toBeNull();
    });
  });

  describe("reveal_card_number", () => {
    it("US-15: the owner sees the full number with a fresh sign-in; an old session must sign in again", async () => {
      expect(await revealCardNumber(pool, { authSessionId: a.authSessionId, cardId: a.cardId })).toBe(
        a.cardNumber,
      );
      await pool.query("UPDATE auth.sessions SET created_at = now() - interval '6 minutes' WHERE id = $1", [
        a.authSessionId,
      ]);
      try {
        expect(
          await codeOf(revealCardNumber(pool, { authSessionId: a.authSessionId, cardId: a.cardId })),
        ).toBe("REAUTH_REQUIRED");
      } finally {
        await pool.query("UPDATE auth.sessions SET created_at = now() WHERE id = $1", [a.authSessionId]);
      }
    });

    it("user A cannot reveal B's card, and no application role reads card numbers directly", async () => {
      expect(await codeOf(revealCardNumber(pool, { authSessionId: a.authSessionId, cardId: b.cardId }))).toBe(
        "CARD_NOT_OWNED",
      );
      for (const role of ["app_web", "app_pay"]) {
        expect(
          await stateOf(pool, "SELECT card_number FROM core.virtual_card WHERE id = $1", [a.cardId], {
            role,
            userId: a.userId,
          }),
          role,
        ).toBe("42501");
      }
    });
  });

  describe("my_statement", () => {
    it("US-34: own postings newest first, with event type, amount, running balance and order group", async () => {
      const page = await myStatement(pool, { authSessionId: a.authSessionId });
      expect(page.items.map((r) => r.eventType)).toEqual(["PURCHASE", "STARTER_GRANT"]);
      const [purchase, grant] = page.items;
      expect(grant?.amountPaise).toBe(100n * CRORE);
      expect(grant?.balanceAfterPaise).toBe(100n * CRORE);
      expect(grant?.orderGroupId).toBeNull();
      expect(purchase?.orderGroupId).toBe(aOrder);
      expect(purchase?.amountPaise).toBeLessThan(0n);
      expect(purchase?.balanceAfterPaise).toBe(await wallet(pool, a.ledgerAccountId));
      expect(page.nextCursor).toBeNull();
      // user A never sees B's postings
      const bPage = await myStatement(pool, { authSessionId: b.authSessionId });
      const aJournals = new Set(page.items.map((r) => r.journalId));
      expect(bPage.items.some((r) => aJournals.has(r.journalId))).toBe(false);
    });

    it("pages by cursor and returns at most 50 per page", async () => {
      const heavy = await user(pool);
      // 55 small spends of the user's own (journals written as the owner, signed in as the user)
      await withTransaction(
        pool,
        async (c) => {
          for (let i = 0; i < 55; i++) {
            const j = uuidv7();
            await c.query(
              "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'MEMBERSHIP', 1)",
              [j],
            );
            await c.query(
              "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -100, 'x'), ($1, $3, 100, 'x')",
              [j, heavy.ledgerAccountId, SINK_ACCOUNT_ID],
            );
          }
          await c.query("SELECT ledger.sync_wallets($1)", [[heavy.ledgerAccountId]]);
        },
        { sessionId: heavy.authSessionId },
      );
      const first = await myStatement(pool, { authSessionId: heavy.authSessionId, pageSize: 500 });
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).not.toBeNull();
      const second = await myStatement(pool, {
        authSessionId: heavy.authSessionId,
        cursor: first.nextCursor,
        pageSize: 500,
      });
      expect(second.items).toHaveLength(6);
      expect(second.nextCursor).toBeNull();
      expect(second.items.at(-1)?.eventType).toBe("STARTER_GRANT");
      expect(first.items[0]?.balanceAfterPaise).toBe(100n * CRORE - 55n * 100n);
      const small = await myStatement(pool, { authSessionId: heavy.authSessionId, pageSize: 2 });
      expect(small.items).toHaveLength(2);
      expect(small.nextCursor).toBe(small.items[1]?.postingId);
      expect(await codeOf(myStatement(pool, { authSessionId: heavy.authSessionId, pageSize: 0 }))).toBe(
        "VALIDATION_FAILED",
      );
    });
  });

  describe("my_orders / my_order", () => {
    it("own order groups with seller orders, lines (name as bought, amounts) and shipment speed and stage times", async () => {
      const page = await myOrders(pool, { authSessionId: a.authSessionId });
      expect(page.items.map((o) => o.orderGroupId)).toEqual([aOrder]);
      const order = page.items[0];
      expect(order?.sellerOrders).toHaveLength(2);
      const seedOrder = order?.sellerOrders.find((so) => so.sellerType === "SEED");
      const userOrder = order?.sellerOrders.find((so) => so.sellerType === "USER");
      expect(seedOrder?.sellerName).toBe("DeluluMart Originals");
      expect(userOrder?.sellerName).toMatch(/^Shop /);
      expect(seedOrder?.lines.map((l) => [l.productId, l.name, l.listPaise])).toEqual([
        [seedP.id, "Moon Lamp", 1_000n * RUPEE],
      ]);
      expect(seedOrder?.shipment?.speed).toBe("STANDARD");
      expect(seedOrder?.shipment?.deliveredAt.getTime()).toBeGreaterThan(
        seedOrder?.shipment?.placedAt.getTime() ?? 0,
      );
      const sum = (order?.sellerOrders ?? []).reduce((t, so) => t + so.totalPaise, 0n);
      expect(sum).toBe(order?.totalPaise);
      expect(await myOrder(pool, { authSessionId: a.authSessionId, orderGroupId: aOrder })).toEqual(order);
    });

    it("user A cannot obtain B's orders, and no personal data or other user's id is returned", async () => {
      expect(await myOrder(pool, { authSessionId: a.authSessionId, orderGroupId: bOrder })).toBeNull();
      const aIds = (await myOrders(pool, { authSessionId: a.authSessionId })).items.map(
        (o) => o.orderGroupId,
      );
      expect(aIds).not.toContain(bOrder);
      const raw = await pool.query<{ j: unknown }>("SELECT core.order_group_json($1) AS j", [aOrder]);
      const text = JSON.stringify(raw.rows[0]?.j);
      expect(text).not.toMatch(PERSONAL);
      expect(text).not.toContain(a.userId);
      expect(text).not.toContain(s.owner.userId);
    });
  });

  describe("my_collection and owns_products", () => {
    it("own ownerships with product id, name and order line id; B's are not listed", async () => {
      const mine = await myCollection(pool, a);
      expect(mine.map((o) => o.productId).sort()).toEqual([seedP.id, stocked.id].sort());
      expect(mine.every((o) => o.name === "Moon Lamp" && o.state === "ACTIVE" && o.orderLineId)).toBe(true);
      const theirs = await myCollection(pool, b);
      expect(theirs.map((o) => o.productId).sort()).toEqual([seedP.id, soldOut.id].sort());
      const mineIds = new Set(mine.map((o) => o.ownershipId));
      expect(theirs.filter((o) => mineIds.has(o.ownershipId))).toEqual([]);
    });

    it("tells which of the given products the actor already owns", async () => {
      const ids = [seedP.id, stocked.id, soldOut.id, draftId];
      expect(await ownsProducts(pool, { authSessionId: a.authSessionId, productIds: ids })).toEqual(
        new Set([seedP.id, stocked.id]),
      );
      expect(await ownsProducts(pool, { authSessionId: b.authSessionId, productIds: ids })).toEqual(
        new Set([seedP.id, soldOut.id]),
      );
      expect(
        await stateOf(
          pool,
          "SELECT * FROM core.owns_products($1::uuid[])",
          [Array.from({ length: 101 }, uuidv7)],
          {
            role: "app_web",
            userId: a.userId,
          },
        ),
      ).toBe("DM001");
    });
  });

  describe("public catalog", () => {
    it("published products with their current version, seller name, availability and zap flag, without a session", async () => {
      const seed = await catalogProduct(pool, seedP.id);
      expect(seed).toMatchObject({
        productId: seedP.id,
        name: "Moon Lamp",
        description: "A lamp that is mostly moon.",
        altText: "A round lamp",
        pricePaise: 1_000n * RUPEE,
        category: "gadgets",
        templateId: 1,
        sellerName: "DeluluMart Originals",
        available: true,
        zap: true,
      });
      expect((await catalogProduct(pool, stocked.id))?.available).toBe(true);
      // the last unit was sold to B
      expect(await catalogProduct(pool, soldOut.id)).toMatchObject({
        available: false,
        sellerName: expect.stringMatching(/^Shop /),
      });
    });

    it("never drafts or any other status", async () => {
      expect(await catalogProduct(pool, draftId)).toBeNull();
      expect(await catalogProduct(pool, hiddenId)).toBeNull();
      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof catalogProducts>> = await catalogProducts(pool, {
          cursor,
          pageSize: 2,
        });
        all.push(...page.items.map((p) => p.productId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(all.sort()).toEqual([seedP.id, stocked.id, soldOut.id].sort());
    });

    it("filters by category and pages by cursor", async () => {
      const other = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 500n * RUPEE });
      await pool.query("UPDATE core.product SET category = 'cosmic-collectibles' WHERE id = $1", [other.id]);
      const cosmic = await catalogProducts(pool, { category: "cosmic-collectibles" });
      expect(cosmic.items.map((p) => p.productId)).toEqual([other.id]);
      expect(cosmic.nextCursor).toBeNull();
      const one = await catalogProducts(pool, { pageSize: 1 });
      const next = await catalogProducts(pool, { pageSize: 1, cursor: one.nextCursor });
      expect((next.items[0]?.productId ?? "") > (one.items[0]?.productId ?? "")).toBe(true);
    });
  });

  describe("privileges", () => {
    it("the account reads are app_web's (and my_wallet/owns_products app_pay's); nothing for the other roles", async () => {
      const { rows } = await pool.query<{ r: string; f: string }>(
        `SELECT r, f FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r,
                unnest(ARRAY['core.my_wallet()','core.reveal_card_number(uuid)','core.my_statement(bigint,integer)',
                             'core.my_orders(uuid,integer)','core.my_order(uuid)','core.my_collection()',
                             'core.owns_products(uuid[])','core.catalog_products(text,uuid,integer)',
                             'core.catalog_product(uuid)']) f
          WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
      );
      const by = (role: string) => rows.filter((x) => x.r === role).map((x) => x.f);
      expect(by("app_web")).toHaveLength(9);
      expect(by("app_pay")).toEqual(["core.my_wallet()", "core.owns_products(uuid[])"]);
      expect(rows.filter((x) => x.r !== "app_web" && x.r !== "app_pay")).toEqual([]);
    });

    it("every account read refuses without a signed-in session", async () => {
      for (const sql of [
        "SELECT * FROM core.my_wallet()",
        "SELECT core.reveal_card_number(gen_random_uuid())",
        "SELECT * FROM core.my_statement(NULL, NULL)",
        "SELECT * FROM core.my_orders(NULL, NULL)",
        "SELECT * FROM core.my_order(gen_random_uuid())",
        "SELECT * FROM core.my_collection()",
        "SELECT * FROM core.owns_products(ARRAY[]::uuid[])",
      ]) {
        expect(await stateOf(pool, sql, [], { role: "app_web" }), sql).toBe("DM001");
      }
      expect(
        await stateOf(pool, "SELECT * FROM core.catalog_products(NULL, NULL, NULL)", [], { role: "app_web" }),
      ).toBe("no error");
    });
  });
});
