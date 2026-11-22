import { createCipheriv, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAddress,
  deleteAddress,
  myAddresses,
  myOrderDelivery,
  setCheckoutDestination,
  setDefaultAddress,
  updateAddress,
} from "../src/address";
import { createCheckoutSession, createPaymentAttempt, pay } from "../src/checkout";
import { myBrandProgress, myEarnings, myInventory, mySellerOrder, mySellerOrders } from "../src/merchant";
import {
  aMinuteLater,
  CLEAN,
  checkout,
  codeOf,
  count,
  key,
  payFor,
  product,
  reconcile,
  user,
  wallet,
} from "./checkout-fixtures";
import {
  createTestDatabase,
  inTx,
  sqlState,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";
import { asFixture, type Creator, creator, ensureCategories, publishListing } from "./listing-fixtures";
import { published } from "./selling-fixtures";

/**
 * PRD R5.2 delivery addresses (migration 0058). The database holds ciphertext only; these tests seal
 * a recognisable plaintext with a throwaway key (as the web server would) so that any copy of the
 * plaintext or the ciphertext in another table can be searched for.
 */
const TEST_KEY = randomBytes(32);

function seal(plaintext: string, userId: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", TEST_KEY, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`address:${userId}`, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]);
}

const PLAIN = (tag: string) =>
  JSON.stringify({
    v: 1,
    recipientName: `Asha Rao ${tag}`,
    line1: "Flat 4B, Sai Krupa Apartments",
    line2: "12/3, 2nd Cross",
    city: "Bengaluru",
    state: "KA",
    postalCode: "560038",
    country: "IN",
  });

describe("delivery addresses (PRD R5.2, migration 0058)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let a: TestUser;
  let b: TestUser;
  let seedLamp: Awaited<ReturnType<typeof product>>;

  const add = (
    u: TestUser,
    tag: string,
    extra: { label?: "HOME" | "WORK" | "OTHER"; makeDefault?: boolean } = {},
  ) =>
    createAddress(pool, {
      authSessionId: u.authSessionId,
      label: extra.label ?? "HOME",
      payloadEnc: seal(PLAIN(tag), u.userId),
      ...(extra.makeDefault === undefined ? {} : { makeDefault: extra.makeDefault }),
    });

  const list = (u: TestUser) => myAddresses(pool, { authSessionId: u.authSessionId });
  const clear = async (u: TestUser) => {
    for (const x of await list(u))
      await deleteAddress(pool, { authSessionId: u.authSessionId, addressId: x.id });
  };

  /** One seed purchase; `address` is put on the quote, `destination` set on the open session. */
  async function buy(
    u: TestUser,
    opts: { address?: string; destination?: string | null } = {},
  ): Promise<{ orderGroupId: string; sessionId: string; totalPaise: bigint }> {
    const lamp = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100_000n });
    const s = await createCheckoutSession(pool, {
      authSessionId: u.authSessionId,
      lines: [{ productId: lamp.id }],
      speedBySeller: { SEED: "STANDARD" },
      ...(opts.address ? { addressId: opts.address } : {}),
      idempotencyKey: key(),
    });
    if (opts.destination !== undefined) {
      await setCheckoutDestination(pool, {
        authSessionId: u.authSessionId,
        sessionId: s.sessionId,
        destination:
          opts.destination === null
            ? { deliverTo: "FICTIONAL_SPOT" }
            : { deliverTo: "ADDRESS", addressId: opts.destination },
      });
    }
    const at = await createPaymentAttempt(pool, {
      authSessionId: u.authSessionId,
      sessionId: s.sessionId,
      method: "BALANCE",
    });
    const r = await pay(pool, {
      authSessionId: u.authSessionId,
      sessionId: s.sessionId,
      attemptId: at.attemptId,
      idempotencyKey: key(),
    });
    return { orderGroupId: r.orderGroupId, sessionId: s.sessionId, totalPaise: r.totalPaise };
  }

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 20 });
    pool = db.pool;
    a = await user(pool);
    b = await user(pool);
    seedLamp = await product(pool, { mode: "UNLIMITED_SEED", pricePaise: 100_000n });
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  describe("address book", () => {
    it("R5.2: a player saves addresses that only they can list; the first one is the default", async () => {
      await clear(a);
      const first = await add(a, "one");
      const second = await add(a, "two", { label: "WORK" });
      await add(b, "b-one");
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);
      const mine = await list(a);
      expect(mine.map((x) => x.id).sort()).toEqual([first.id, second.id].sort());
      expect(mine[0]?.id).toBe(first.id); // the default first
      expect(mine.find((x) => x.id === second.id)?.payloadEnc.equals(second.payloadEnc)).toBe(true);
      expect((await list(b)).every((x) => !mine.some((m) => m.id === x.id))).toBe(true);
    });

    it("R5.2: at most five addresses per player (ADDRESS_LIMIT), from configuration", async () => {
      await clear(a);
      for (let i = 0; i < 5; i++) await add(a, `cap-${i}`);
      expect(await codeOf(add(a, "sixth"))).toBe("ADDRESS_LIMIT");
      expect(await list(a)).toHaveLength(5);
      // another player is not affected
      await clear(b);
      expect(await codeOf(add(b, "b"))).toBe("ok");
      await clear(a);
    });

    it("R5.2: one default per player, enforced by the database (partial unique index)", async () => {
      await clear(a);
      const x = await add(a, "x");
      const y = await add(a, "y");
      const switched = await setDefaultAddress(pool, { authSessionId: a.authSessionId, addressId: y.id });
      expect(switched.isDefault).toBe(true);
      const now = await list(a);
      expect(now.filter((r) => r.isDefault).map((r) => r.id)).toEqual([y.id]);
      // even the owner cannot write a second default
      expect(
        await sqlState(pool.query("UPDATE private.address SET is_default = true WHERE id = $1", [x.id])),
      ).toBe("23505");
      // making a new address the default moves the flag
      const z = await add(a, "z", { makeDefault: true });
      expect((await list(a)).filter((r) => r.isDefault).map((r) => r.id)).toEqual([z.id]);
    });

    it("R5.2: deleting the default promotes the most recent remaining address", async () => {
      await clear(a);
      const older = await add(a, "older");
      const newer = await add(a, "newer");
      const def = await add(a, "def", { makeDefault: true });
      const r = await deleteAddress(pool, { authSessionId: a.authSessionId, addressId: def.id });
      expect(r).toEqual({ deletedId: def.id, defaultAddressId: newer.id });
      expect((await list(a)).filter((x) => x.isDefault).map((x) => x.id)).toEqual([newer.id]);
      // deleting a non-default leaves the default alone; deleting the last leaves none
      await deleteAddress(pool, { authSessionId: a.authSessionId, addressId: older.id });
      const last = await deleteAddress(pool, { authSessionId: a.authSessionId, addressId: newer.id });
      expect(last.defaultAddressId).toBeNull();
      expect(await list(a)).toEqual([]);
      expect(await count(pool, "SELECT count(*) AS n FROM private.address WHERE id = $1", [def.id])).toBe(0);
    });

    it("R5.2: editing changes label and ciphertext; nothing else can be edited", async () => {
      await clear(a);
      const x = await add(a, "before");
      const sealed = seal(PLAIN("after"), a.userId);
      const edited = await updateAddress(pool, {
        authSessionId: a.authSessionId,
        addressId: x.id,
        label: "OTHER",
        payloadEnc: sealed,
      });
      expect(edited.label).toBe("OTHER");
      expect(edited.payloadEnc.equals(sealed)).toBe(true);
      expect(edited.isDefault).toBe(true);
      expect(edited.updatedAt.getTime()).toBeGreaterThanOrEqual(x.updatedAt.getTime());
      expect(await codeOf(updateAddress(pool, { authSessionId: a.authSessionId, addressId: x.id }))).toBe(
        "VALIDATION_FAILED",
      );
    });

    it("IDOR: another player's address id is ADDRESS_NOT_FOUND for edit, delete and default", async () => {
      const theirs = await add(b, "theirs");
      const as = { authSessionId: a.authSessionId, addressId: theirs.id };
      expect(await codeOf(updateAddress(pool, { ...as, label: "WORK" }))).toBe("ADDRESS_NOT_FOUND");
      expect(await codeOf(deleteAddress(pool, as))).toBe("ADDRESS_NOT_FOUND");
      expect(await codeOf(setDefaultAddress(pool, as))).toBe("ADDRESS_NOT_FOUND");
      expect(await codeOf(deleteAddress(pool, { ...as, addressId: uuidv7() }))).toBe("ADDRESS_NOT_FOUND");
      // unchanged
      const still = (await list(b)).find((x) => x.id === theirs.id);
      expect(still?.label).toBe("HOME");
    });

    it("the database checks label and ciphertext size itself", async () => {
      const call = (label: unknown, payload: unknown) =>
        stateOf(pool, "SELECT core.address_create($1, $2, false)", [label, payload], {
          role: "app_web",
          userId: a.userId,
        });
      expect(await call("HOUSE", randomBytes(64))).toBe("DM001");
      expect(await call("HOME", randomBytes(8))).toBe("DM001");
      expect(await call("HOME", randomBytes(5000))).toBe("DM001");
      expect(await call("HOME", null)).toBe("DM001");
      // no actor
      expect(
        await stateOf(pool, "SELECT core.address_create('HOME', $1, false)", [randomBytes(64)], {
          role: "app_web",
        }),
      ).toBe("DM001");
    });
  });

  describe("no direct table access (definer functions only)", () => {
    it("application roles hold no privilege on the address, destination or delivery-snapshot tables", async () => {
      const statements = [
        "SELECT 1 FROM private.address",
        "INSERT INTO private.address (id, user_id, kind, label, payload_enc) VALUES (gen_random_uuid(), $1, 'REAL', 'HOME', '\\x01')",
        "UPDATE private.address SET label = 'WORK'",
        "DELETE FROM private.address",
        "SELECT 1 FROM private.order_delivery",
        "UPDATE private.order_delivery SET payload_enc = NULL",
        "SELECT 1 FROM core.checkout_destination",
        "INSERT INTO core.checkout_destination (session_id, user_id, kind) VALUES (gen_random_uuid(), $1, 'FICTIONAL_SPOT')",
      ];
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        for (const sql of statements) {
          const params = sql.includes("$1") ? [a.userId] : [];
          expect(await stateOf(pool, sql, params, { role, userId: a.userId }), `${role}: ${sql}`).toBe(
            "42501",
          );
        }
      }
    });

    it("row-level security is on for the new tables; commands are definers with a pinned search_path, not executable by PUBLIC", async () => {
      const rls = await pool.query<{ t: string; on: boolean }>(
        `SELECT c.oid::regclass::text AS t, c.relrowsecurity AS on FROM pg_class c
          WHERE c.oid IN ('private.order_delivery'::regclass, 'core.checkout_destination'::regclass, 'private.address'::regclass)
          ORDER BY 1`,
      );
      expect(rls.rows.every((r) => r.on)).toBe(true);
      const fns = await pool.query<{ f: string; definer: boolean; pinned: boolean; pub: boolean }>(
        `SELECT p.oid::regprocedure::text AS f, p.prosecdef AS definer,
                COALESCE('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false) AS pinned,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'core' AND p.proname IN ('address_create', 'address_update', 'address_delete',
                'address_set_default', 'my_addresses', 'my_order_delivery', 'checkout_set_destination',
                'checkout_address_check', 'purchase_record_delivery')`,
      );
      expect(fns.rows.length).toBe(9);
      for (const r of fns.rows) expect(r, r.f).toMatchObject({ definer: true, pinned: true, pub: false });
    });
  });

  describe("checkout and orders", () => {
    it("decisions.md #4: with no choice the order goes to the fictional delivery spot", async () => {
      const u = await user(pool);
      const o = await buy(u);
      expect(
        await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: o.orderGroupId }),
      ).toEqual({
        kind: "FICTIONAL_SPOT",
      });
    });

    it("R5.2: an address chosen at checkout is copied onto the order; the shipment references it", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "home");
      const o = await buy(u, { address: home.id });
      const d = await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: o.orderGroupId });
      expect(d).toMatchObject({ kind: "ADDRESS", label: "HOME" });
      expect(d?.kind === "ADDRESS" && d.payloadEnc.equals(home.payloadEnc)).toBe(true);
      const shipments = await pool.query<{ address_id: string | null }>(
        `SELECT sh.address_id FROM core.shipment sh JOIN core.seller_order so ON so.id = sh.seller_order_id
          WHERE so.order_group_id = $1`,
        [o.orderGroupId],
      );
      expect(shipments.rows.map((r) => r.address_id)).toEqual([home.id]);
    });

    it("R5.2: the destination can be changed on the open session, and back to the fictional spot", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "home2");
      const work = await add(u, "work2", { label: "WORK" });
      const viaPatch = await buy(u, { address: home.id, destination: work.id });
      const d1 = await myOrderDelivery(pool, {
        authSessionId: u.authSessionId,
        orderGroupId: viaPatch.orderGroupId,
      });
      expect(d1).toMatchObject({ kind: "ADDRESS", label: "WORK" });
      const back = await buy(u, { address: home.id, destination: null });
      expect(
        await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: back.orderGroupId }),
      ).toEqual({ kind: "FICTIONAL_SPOT" });
    });

    it("IDOR: another player's address id is refused at session create and at destination change, with a stable code", async () => {
      const u = await user(pool);
      const theirs = await add(b, "not-yours");
      const balance = await wallet(pool, u.ledgerAccountId);
      expect(
        await codeOf(
          createCheckoutSession(pool, {
            authSessionId: u.authSessionId,
            lines: [{ productId: seedLamp.id }],
            speedBySeller: { SEED: "STANDARD" },
            addressId: theirs.id,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("ADDRESS_NOT_FOUND");
      const s = await createCheckoutSession(pool, {
        authSessionId: u.authSessionId,
        lines: [{ productId: seedLamp.id }],
        speedBySeller: { SEED: "STANDARD" },
        idempotencyKey: key(),
      });
      expect(
        await codeOf(
          setCheckoutDestination(pool, {
            authSessionId: u.authSessionId,
            sessionId: s.sessionId,
            destination: { deliverTo: "ADDRESS", addressId: theirs.id },
          }),
        ),
      ).toBe("ADDRESS_NOT_FOUND");
      // and nobody can steer someone else's session
      expect(
        await codeOf(
          setCheckoutDestination(pool, {
            authSessionId: b.authSessionId,
            sessionId: s.sessionId,
            destination: { deliverTo: "FICTIONAL_SPOT" },
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await wallet(pool, u.ledgerAccountId)).toBe(balance);
    });

    it("the pay transaction re-checks the destination: an address deleted after it was chosen refuses the payment and moves nothing", async () => {
      const u = await user(pool);
      await clear(u);
      const gone = await add(u, "gone");
      const s = await createCheckoutSession(pool, {
        authSessionId: u.authSessionId,
        lines: [{ productId: seedLamp.id }],
        speedBySeller: { SEED: "STANDARD" },
        addressId: gone.id,
        idempotencyKey: key(),
      });
      await deleteAddress(pool, { authSessionId: u.authSessionId, addressId: gone.id });
      const at = await createPaymentAttempt(pool, {
        authSessionId: u.authSessionId,
        sessionId: s.sessionId,
        method: "BALANCE",
      });
      const before = await wallet(pool, u.ledgerAccountId);
      const orders = await count(
        pool,
        "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1",
        [u.userId],
      );
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: u.authSessionId,
            sessionId: s.sessionId,
            attemptId: at.attemptId,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("ADDRESS_NOT_FOUND");
      expect(await wallet(pool, u.ledgerAccountId)).toBe(before);
      expect(
        await count(pool, "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [u.userId]),
      ).toBe(orders);
      // the same holds for a destination changed to an address that is then deleted
      const later = await add(u, "later");
      const s2 = await createCheckoutSession(pool, {
        authSessionId: u.authSessionId,
        lines: [{ productId: seedLamp.id }],
        speedBySeller: { SEED: "STANDARD" },
        idempotencyKey: key(),
      });
      await setCheckoutDestination(pool, {
        authSessionId: u.authSessionId,
        sessionId: s2.sessionId,
        destination: { deliverTo: "ADDRESS", addressId: later.id },
      });
      await deleteAddress(pool, { authSessionId: u.authSessionId, addressId: later.id });
      const at2 = await createPaymentAttempt(pool, {
        authSessionId: u.authSessionId,
        sessionId: s2.sessionId,
        method: "BALANCE",
      });
      expect(
        await codeOf(
          pay(pool, {
            authSessionId: u.authSessionId,
            sessionId: s2.sessionId,
            attemptId: at2.attemptId,
            idempotencyKey: key(),
          }),
        ),
      ).toBe("ADDRESS_NOT_FOUND");
      expect(await reconcile(pool)).toEqual(CLEAN);
    });

    it("invariant 3 / R5.2: the address never changes the price", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "price");
      const plain = await createCheckoutSession(pool, {
        authSessionId: u.authSessionId,
        lines: [{ productId: seedLamp.id }],
        speedBySeller: { SEED: "STANDARD" },
        idempotencyKey: key(),
      });
      const withAddress = await createCheckoutSession(pool, {
        authSessionId: u.authSessionId,
        lines: [{ productId: seedLamp.id }],
        speedBySeller: { SEED: "STANDARD" },
        addressId: home.id,
        idempotencyKey: key(),
      });
      expect(withAddress.totalPaise).toBe(plain.totalPaise);
      expect(withAddress.sellers).toEqual(plain.sellers);
    });

    it("R5.2: editing the address later does not change a past order's copy", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "original");
      const o = await buy(u, { address: home.id });
      await updateAddress(pool, {
        authSessionId: u.authSessionId,
        addressId: home.id,
        label: "WORK",
        payloadEnc: seal(PLAIN("edited"), u.userId),
      });
      const d = await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: o.orderGroupId });
      expect(d).toMatchObject({ kind: "ADDRESS", label: "HOME" });
      expect(d?.kind === "ADDRESS" && d.payloadEnc.equals(home.payloadEnc)).toBe(true);
    });

    it("R5.2: deleting the address removes it from past orders too: they keep only 'Address removed'", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "to-delete");
      const o = await buy(u, { address: home.id });
      await deleteAddress(pool, { authSessionId: u.authSessionId, addressId: home.id });
      expect(
        await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: o.orderGroupId }),
      ).toEqual({
        kind: "ADDRESS_REMOVED",
      });
      // no copy of the ciphertext remains anywhere in the order's delivery record
      const row = await pool.query("SELECT * FROM private.order_delivery WHERE order_group_id = $1", [
        o.orderGroupId,
      ]);
      expect(row.rows[0]).toMatchObject({ payload_enc: null, label: null, address_id: null });
      expect(row.rows[0]?.removed_at).toBeInstanceOf(Date);
    });

    it("erasure: an address deleted by any path (an account's cascade too) erases the order copies", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "cascade");
      const o = await buy(u, { address: home.id });
      await pool.query("DELETE FROM private.address WHERE id = $1", [home.id]); // as the owner, like a cascade
      expect(
        await myOrderDelivery(pool, { authSessionId: u.authSessionId, orderGroupId: o.orderGroupId }),
      ).toEqual({
        kind: "ADDRESS_REMOVED",
      });
    });

    it("the order's delivery copy is immutable, except for erasure; it cannot be deleted", async () => {
      const u = await user(pool);
      await clear(u);
      const home = await add(u, "immutable");
      const o = await buy(u, { address: home.id });
      const id = o.orderGroupId;
      expect(
        await sqlState(
          pool.query("UPDATE private.order_delivery SET payload_enc = $2 WHERE order_group_id = $1", [
            id,
            randomBytes(64),
          ]),
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          pool.query("UPDATE private.order_delivery SET label = 'WORK' WHERE order_group_id = $1", [id]),
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          pool.query(
            "UPDATE private.order_delivery SET kind = 'FICTIONAL_SPOT', label = NULL, payload_enc = NULL, address_id = NULL WHERE order_group_id = $1",
            [id],
          ),
        ),
      ).toBe("23514");
      expect(
        await sqlState(pool.query("DELETE FROM private.order_delivery WHERE order_group_id = $1", [id])),
      ).toBe("23514");
    });

    it("owner only: another player's order has no delivery answer", async () => {
      const u = await user(pool);
      const o = await buy(u);
      expect(
        await myOrderDelivery(pool, { authSessionId: b.authSessionId, orderGroupId: o.orderGroupId }),
      ).toBeNull();
    });
  });

  describe("privacy (invariant 8, R5.2: never the seller, logs, analytics or outbox)", () => {
    let s: Creator;
    let u: TestUser;
    let sealedHex: string;
    let sealedB64: string;
    let orderRef: string;
    const TAG = `zq${randomBytes(4).toString("hex")}`;

    beforeAll(async () => {
      await ensureCategories(pool);
      const seeds = await published(pool, 3);
      s = await creator(pool, seeds);
      u = await user(pool);
      const listing = asFixture(await publishListing(pool, s, { quantity: 3 }));
      await clear(u);
      const home = await add(u, TAG);
      sealedHex = home.payloadEnc.toString("hex");
      sealedB64 = home.payloadEnc.toString("base64");
      const co = await checkout(pool, u, [listing], { [s.companyId]: "STANDARD" });
      await setCheckoutDestination(pool, {
        authSessionId: u.authSessionId,
        sessionId: co.sessionId,
        destination: { deliverTo: "ADDRESS", addressId: home.id },
      });
      await payFor(pool, u, co);
      await aMinuteLater(pool); // 0060: a seller sees an order once its minute has ended
      const page = await mySellerOrders(pool, { authSessionId: s.u.authSessionId });
      orderRef = page.items[0]?.orderRef ?? "";
      expect(orderRef).not.toBe("");
    }, 240_000);

    const leaks = (text: string) =>
      [
        sealedHex,
        sealedB64,
        sealedHex.slice(0, 40),
        TAG,
        "560038",
        "Bengaluru",
        "payloadEnc",
        "addressId",
        "address",
      ].filter((needle) => text.toLowerCase().includes(needle.toLowerCase()));

    it("R5.2: no seller-facing read carries the buyer's address, label, PIN code or any part of the ciphertext", async () => {
      const reads: Record<string, unknown> = {
        orders: await mySellerOrders(pool, { authSessionId: s.u.authSessionId }),
        order: await mySellerOrder(pool, { authSessionId: s.u.authSessionId, orderRef }),
        earnings: await myEarnings(pool, { authSessionId: s.u.authSessionId }),
        inventory: await myInventory(pool, { authSessionId: s.u.authSessionId }),
        brand: await myBrandProgress(pool, { authSessionId: s.u.authSessionId }),
      };
      for (const [name, value] of Object.entries(reads)) {
        const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        expect(leaks(text), name).toEqual([]);
      }
      // and the seller cannot ask the buyer's delivery question either
      const group = await pool.query<{ id: string }>(
        "SELECT order_group_id AS id FROM core.seller_order WHERE company_id = $1 LIMIT 1",
        [s.companyId],
      );
      expect(
        await myOrderDelivery(pool, {
          authSessionId: s.u.authSessionId,
          orderGroupId: group.rows[0]?.id ?? "",
        }),
      ).toBeNull();
    });

    it("invariant 8: no outbox, audit or analytics row written by an address create and a purchase carries the address or its ciphertext", async () => {
      const tables = await pool.query<{ t: string }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('audit', 'analytics', 'research')`,
      );
      expect(tables.rows.map((r) => r.t)).toContain("audit.outbox");
      for (const { t } of tables.rows) {
        const rows = await pool.query<{ j: string }>(`SELECT to_jsonb(x)::text AS j FROM ${t} x`);
        for (const r of rows.rows) {
          expect(
            leaks(r.j).filter((n) => n !== "address"),
            t,
          ).toEqual([]);
          expect(r.j, t).not.toMatch(/\\\\x[0-9a-f]{40}/i);
        }
      }
      // the checkout session's stored quote holds an id at most, never the address
      const quotes = await pool.query<{ j: string }>(
        "SELECT quote::text AS j FROM core.checkout_session WHERE user_id = $1",
        [u.userId],
      );
      for (const q of quotes.rows)
        expect(leaks(q.j).filter((n) => n !== "addressId" && n !== "address")).toEqual([]);
    });
  });

  describe("configuration (invariant 10)", () => {
    it("R5.2: the per-player maximum is read from address_max_per_user", async () => {
      await inTx(pool, async (c) => {
        await c.query(
          `INSERT INTO core.config_version (values, effective_from, note)
           SELECT values || '{"address_max_per_user": 2}'::jsonb, now(), 'address cap test'
             FROM core.config_version ORDER BY id DESC LIMIT 1`,
        );
      });
      await clear(b);
      await add(b, "c1");
      await add(b, "c2");
      expect(await codeOf(add(b, "c3"))).toBe("ADDRESS_LIMIT");
      await clear(b);
    });
  });
});
