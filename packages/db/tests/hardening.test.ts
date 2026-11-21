import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINT_ACCOUNT_ID, SINK_ACCOUNT_ID } from "../src/provision";
import { checkout, payFor, product, RUPEE, seller, standard, user, wallet } from "./checkout-fixtures";
import {
  ADMIN_URL,
  asActor,
  commitError,
  commitState,
  countRows,
  createProfile,
  createTestDatabase,
  plant,
  provisionAccount,
  provisionInput,
  RAW_WRITER,
  sqlState,
  stateOf,
  type TestDatabase,
  type TestUser,
  uuidv7,
} from "./helpers";

const STARTER = 100_000_000_000n;
const APP_ROLES = ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"];
const RLS_SCHEMAS = ["core", "ledger", "private", "analytics", "audit", "sandbox", "research"];

/** Ids of a fully populated buyer B, seen from user A's session. */
interface Fixture {
  a: TestUser;
  b: TestUser;
  /** owner of `company` (a bare profile) */
  seller: string;
  company: string;
  sessionB: string;
  attemptB: string;
  groupB: string;
  sellerOrderB: string;
  publishedVersion: string;
  draftVersion: string;
}

async function seed(pool: pg.Pool): Promise<Fixture> {
  const a = await provisionAccount(pool, provisionInput());
  const b = await provisionAccount(pool, provisionInput());
  const seller = await createProfile(pool);
  const company = uuidv7();
  await pool.query("INSERT INTO core.company (id, owner_user_id, name) VALUES ($1, $2, 'Shop')", [
    company,
    seller,
  ]);
  for (const u of [a.userId, b.userId]) {
    await pool.query(
      "INSERT INTO private.address (id, user_id, kind, label, payload_enc) VALUES ($1, $2, 'REAL', 'HOME', $3)",
      [uuidv7(), u, randomBytes(48)],
    );
    await pool.query(
      "INSERT INTO core.idempotency_record (user_id, command, key, request_hash) VALUES ($1, 'pay', 'k1', '\\x00')",
      [u],
    );
  }
  // B's purchase history is planted (triggers and foreign keys off): these tests ask who can
  // SEE such rows, and the rows (an order without a journal, a platform coupon redemption)
  // are impossible to create under the money rules of migration 0016.
  const sessionB = uuidv7();
  const attemptB = uuidv7();
  const groupB = uuidv7();
  const sellerOrderB = uuidv7();
  await plant(pool, async (c) => {
    await c.query(
      `INSERT INTO core.checkout_session (id, user_id, type, quote, total_paise, config_version, expires_at)
       VALUES ($1, $2, 'PRODUCT_PURCHASE', '{}', 10000, 1, now() + interval '5 minutes')`,
      [sessionB, b.userId],
    );
    await c.query(
      "INSERT INTO core.payment_attempt (id, session_id, user_id, method, reference) VALUES ($1, $2, $3, 'CARD', $4)",
      [attemptB, sessionB, b.userId, `ref-${attemptB}`],
    );
    await c.query(
      "INSERT INTO core.payment_challenge (attempt_id, kind, expires_at) VALUES ($1, 'PIN', now() + interval '5 minutes')",
      [attemptB],
    );
    await c.query(
      `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
       VALUES ($1, $2, $3, $4, $5, 'PLAYER', 10000, 1)`,
      [groupB, b.userId, sessionB, attemptB, uuidv7()],
    );
    await c.query(
      `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise)
       VALUES ($1, $2, $3, $4, 'USER', 10000, 500, 9500)`,
      [sellerOrderB, groupB, b.userId, company],
    );
    const lineB = uuidv7();
    await c.query(
      `INSERT INTO core.order_line (id, seller_order_id, product_id, product_version_id, snapshot, list_paise,
         seller_discount_paise, platform_discount_paise, fee_paise)
       VALUES ($1, $2, $3, $4, '{}', 10000, 0, 0, 500)`,
      [lineB, sellerOrderB, uuidv7(), uuidv7()],
    );
    await c.query(
      `INSERT INTO core.shipment (id, seller_order_id, speed, placed_at, packed_at, shipped_at, out_at, delivered_at)
       VALUES ($1, $2, 'STANDARD', now(), now(), now(), now(), now())`,
      [uuidv7(), sellerOrderB],
    );
    await c.query(
      "INSERT INTO core.ownership (id, user_id, product_id, order_line_id) VALUES ($1, $2, $3, $4)",
      [uuidv7(), b.userId, uuidv7(), lineB],
    );
    await c.query(
      "INSERT INTO core.membership (id, user_id, starts_at, ends_at, journal_id) VALUES ($1, $2, now(), now() + interval '30 days', $3)",
      [uuidv7(), b.userId, uuidv7()],
    );
    const coupon = uuidv7();
    await c.query(
      "INSERT INTO core.coupon (id, scope, code_normalised, kind, value) VALUES ($1, 'PLATFORM', $2, 'FLAT', 100)",
      [coupon, `C${coupon.slice(0, 8)}`],
    );
    await c.query(
      "INSERT INTO core.coupon_redemption (coupon_id, user_id, order_group_id, discount_paise) VALUES ($1, $2, $3, 100)",
      [coupon, b.userId, groupB],
    );
  });
  const product = async (status: string): Promise<string> => {
    const id = uuidv7();
    const version = uuidv7();
    await pool.query(
      `INSERT INTO core.product (id, company_id, seller_type, status, category, inventory_mode)
       VALUES ($1, $2, 'USER', $3, 'gadgets', 'STANDARD_STOCKED')`,
      [id, company, status],
    );
    await pool.query(
      `INSERT INTO core.product_version (id, product_id, revision, name, description, alt_text, template_id, price_paise)
       VALUES ($1, $2, 1, 'Thing', 'A thing', 'A thing', 1, 10000)`,
      [version, id],
    );
    await pool.query("UPDATE core.product SET current_version_id = $2 WHERE id = $1", [id, version]);
    return version;
  };
  const publishedVersion = await product("PUBLISHED");
  const draftVersion = await product("DRAFT");
  return { a, b, seller, company, sessionB, attemptB, groupB, sellerOrderB, publishedVersion, draftVersion };
}

describe("security hardening (review findings)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let f: Fixture;
  const web = () => ({ role: "app_web", userId: f.a.userId });
  const payRole = () => ({ role: "app_pay", userId: f.a.userId });
  /** a writer the grants did not stop (helpers.ts): the structural rules alone refuse it */
  const raw = () => ({ role: RAW_WRITER, userId: f.a.userId });
  /** A journal created in this transaction and not yet checked, so not sealed (0016 R9). */
  const openJournal = async (c: pg.PoolClient): Promise<string> => {
    const j = uuidv7();
    await c.query(
      "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'COMPENSATION', 1)",
      [j],
    );
    return j;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    f = await seed(pool);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe("finding 1: configuration and the starter grant", () => {
    for (const role of ["app_web", "app_pay", "app_jobs"]) {
      it(`${role} cannot insert, update or delete configuration or system switches`, async () => {
        const statements = [
          'INSERT INTO core.config_version (values, effective_from) VALUES (\'{"starter_grant_paise":"999999999999999"}\', now())',
          "UPDATE core.config_version SET values = '{}'",
          "DELETE FROM core.config_version",
          "INSERT INTO core.system_switch (name, enabled, updated_at) VALUES ('evil', true, now())",
          "UPDATE core.system_switch SET enabled = false",
          "DELETE FROM core.system_switch",
        ];
        for (const sql of statements) {
          expect(await stateOf(pool, sql, [], { role, userId: f.a.userId }), sql).toBe("42501");
        }
        // sixth review (0047): app_jobs reads no table directly, configuration included
        const read = role === "app_jobs" ? "42501" : "no error";
        expect(await stateOf(pool, "SELECT 1 FROM core.config_version", [], { role })).toBe(read);
        expect(await stateOf(pool, "SELECT 1 FROM core.system_switch", [], { role })).toBe(read);
      });
    }

    it("a STARTER grant_record can only carry exactly 100,000,000,000 paise", async () => {
      const user = await createProfile(pool);
      const insert = (amount: string) =>
        asActor(pool, {}, async (c) =>
          sqlState(
            c.query(
              "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount) VALUES ($1, $2, $3, 'STARTER', $4)",
              [uuidv7(), user, await openJournal(c), amount],
            ),
          ),
        );
      expect(await insert("100000000001")).toBe("23514");
      expect(await insert("1")).toBe("23514");
      expect(await insert(STARTER.toString())).toBe("no error");
    });

    it("a STARTER_GRANT journal must be backed by a STARTER grant_record of the credited amount", async () => {
      const user = await createProfile(pool);
      const message = await commitError(pool, {}, async (c) => {
        const la = uuidv7();
        await c.query("INSERT INTO ledger.ledger_account (id, type, user_id) VALUES ($1, 'USER', $2)", [
          la,
          user,
        ]);
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'STARTER_GRANT', 1)",
          [j],
        );
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -5, 'x'), ($1, $3, 5, 'x')",
          [j, MINT_ACCOUNT_ID, la],
        );
      });
      expect(message).toMatch(/grant_record/);
    });
  });

  describe("finding 2: row-level security on every table", () => {
    it("every table in the application schemas has RLS enabled and at least one policy", async () => {
      const { rows } = await pool.query<{ t: string; rls: boolean; policies: string }>(
        `SELECT c.oid::regclass::text AS t, c.relrowsecurity AS rls,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p')`,
        [RLS_SCHEMAS],
      );
      expect(rows.length).toBeGreaterThanOrEqual(46);
      expect(rows.filter((r) => !r.rls).map((r) => r.t)).toEqual([]);
      expect(rows.filter((r) => r.policies === "0").map((r) => r.t)).toEqual([]);
    });

    it("application roles own no tables and cannot bypass RLS (so FORCE is not needed)", async () => {
      const roles = await pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
        [APP_ROLES],
      );
      expect(roles.rows).toEqual(
        [...APP_ROLES].sort().map((rolname) => ({ rolname, rolbypassrls: false, rolsuper: false })),
      );
      const owned = await pool.query(
        `SELECT c.oid::regclass::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY($1) AND pg_get_userbyid(c.relowner) = ANY($2)`,
        [RLS_SCHEMAS, APP_ROLES],
      );
      expect(owned.rows).toEqual([]);
    });

    it("as app_web signed in as A, none of B's owner-scoped rows are visible", async () => {
      const probes: [string, string, unknown[]][] = [
        ["user_profile", "SELECT count(*) AS n FROM core.user_profile WHERE id = $1", [f.b.userId]],
        ["wallet", "SELECT count(*) AS n FROM ledger.wallet WHERE account_id = $1", [f.b.ledgerAccountId]],
        ["posting", "SELECT count(*) AS n FROM ledger.posting WHERE account_id = $1", [f.b.ledgerAccountId]],
        [
          "ledger_account",
          "SELECT count(*) AS n FROM ledger.ledger_account WHERE id = $1",
          [f.b.ledgerAccountId],
        ],
        ["grant_record", "SELECT count(*) AS n FROM ledger.grant_record WHERE user_id = $1", [f.b.userId]],
        ["journal", "SELECT count(*) AS n FROM ledger.journal WHERE id = $1", [f.b.starterJournalId]],
        ["bank_account", "SELECT count(*) AS n FROM core.bank_account WHERE user_id = $1", [f.b.userId]],
        ["virtual_card", "SELECT count(*) AS n FROM core.virtual_card WHERE user_id = $1", [f.b.userId]],
        ["idempotency", "SELECT count(*) AS n FROM core.idempotency_record WHERE user_id = $1", [f.b.userId]],
        ["checkout", "SELECT count(*) AS n FROM core.checkout_session WHERE user_id = $1", [f.b.userId]],
        ["attempt", "SELECT count(*) AS n FROM core.payment_attempt WHERE user_id = $1", [f.b.userId]],
        ["challenge", "SELECT count(*) AS n FROM core.payment_challenge WHERE attempt_id = $1", [f.attemptB]],
        ["order_group", "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [f.b.userId]],
        ["seller_order", "SELECT count(*) AS n FROM core.seller_order WHERE id = $1", [f.sellerOrderB]],
        [
          "order_line",
          "SELECT count(*) AS n FROM core.order_line WHERE seller_order_id = $1",
          [f.sellerOrderB],
        ],
        ["shipment", "SELECT count(*) AS n FROM core.shipment WHERE seller_order_id = $1", [f.sellerOrderB]],
        ["ownership", "SELECT count(*) AS n FROM core.ownership WHERE user_id = $1", [f.b.userId]],
        ["membership", "SELECT count(*) AS n FROM core.membership WHERE user_id = $1", [f.b.userId]],
        ["redemption", "SELECT count(*) AS n FROM core.coupon_redemption WHERE user_id = $1", [f.b.userId]],
        ["address", "SELECT count(*) AS n FROM private.address WHERE user_id = $1", [f.b.userId]],
      ];
      const seen = await asActor(pool, web(), async (c) => {
        const out: Record<string, number> = {};
        for (const [label, sql, params] of probes) out[label] = await countRows(c, sql, params);
        return out;
      });
      expect(seen).toEqual(Object.fromEntries(probes.map(([label]) => [label, 0])));
      // the same rows exist (the owner sees them); app_jobs reads no table directly (sixth review, 0047)
      expect(
        await countRows(pool, "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1", [
          f.b.userId,
        ]),
      ).toBe(1);
      expect(
        await stateOf(
          pool,
          "SELECT count(*) AS n FROM core.order_group WHERE buyer_user_id = $1",
          [f.b.userId],
          {
            role: "app_jobs",
          },
        ),
      ).toBe("42501");
    });

    it("as app_web, user A sees their own rows, their own postings only, and MINT/SINK account rows", async () => {
      const seen = await asActor(pool, web(), async (c) => ({
        profile: await countRows(c, "SELECT count(*) AS n FROM core.user_profile"),
        wallet: await countRows(c, "SELECT count(*) AS n FROM ledger.wallet"),
        postings: await countRows(c, "SELECT count(*) AS n FROM ledger.posting"),
        journals: await countRows(c, "SELECT count(*) AS n FROM ledger.journal"),
        grants: await countRows(c, "SELECT count(*) AS n FROM ledger.grant_record"),
        accounts: await countRows(c, "SELECT count(*) AS n FROM ledger.ledger_account"),
        mintPostings: await countRows(c, "SELECT count(*) AS n FROM ledger.posting WHERE account_id = $1", [
          MINT_ACCOUNT_ID,
        ]),
      }));
      expect(seen).toEqual({
        profile: 1,
        wallet: 1,
        postings: 1,
        journals: 1,
        grants: 1,
        accounts: 3,
        mintPostings: 0,
      });
    });

    it("seller side: the company's owner sees its seller orders, lines and shipments but not the buyer's group", async () => {
      const sellerSide = async (c: pg.PoolClient) => ({
        sellerOrders: await countRows(c, "SELECT count(*) AS n FROM core.seller_order"),
        lines: await countRows(c, "SELECT count(*) AS n FROM core.order_line"),
        shipments: await countRows(c, "SELECT count(*) AS n FROM core.shipment"),
        groups: await countRows(c, "SELECT count(*) AS n FROM core.order_group"),
      });
      expect(await asActor(pool, { role: "app_web", userId: f.seller }, sellerSide)).toEqual({
        sellerOrders: 1,
        lines: 1,
        shipments: 1,
        groups: 0,
      });
      // user A naming the company in app.company_id (a setting A controls) sees none of it
      const claimed = await asActor(pool, web(), async (c) => {
        await c.query("SELECT set_config('app.company_id', $1, true)", [f.company]);
        return sellerSide(c);
      });
      expect(claimed).toEqual({ sellerOrders: 0, lines: 0, shipments: 0, groups: 0 });
    });

    it("purchases are anonymous to sellers: the owner reads its seller orders but never their buyer", async () => {
      const owner = { role: "app_web", userId: f.seller };
      expect(
        await stateOf(
          pool,
          "SELECT buyer_user_id FROM core.seller_order WHERE id = $1",
          [f.sellerOrderB],
          owner,
        ),
      ).toBe("42501");
      expect(await stateOf(pool, "SELECT * FROM core.seller_order", [], owner)).toBe("42501");
      const visible = await asActor(pool, owner, async (c) => {
        const { rows } = await c.query<{ id: string; net_paise: string }>(
          "SELECT id, net_paise FROM core.seller_order WHERE id = $1",
          [f.sellerOrderB],
        );
        return rows;
      });
      expect(visible).toEqual([{ id: f.sellerOrderB, net_paise: "9500" }]);
    });

    it("app_web cannot read tombstones, audit or raw analytics, but can append audit_log and analytics events", async () => {
      for (const sql of [
        "SELECT 1 FROM core.identity_tombstone",
        "SELECT 1 FROM audit.outbox",
        "SELECT 1 FROM audit.audit_log",
        "SELECT 1 FROM audit.consumer_receipt",
        "SELECT 1 FROM analytics.event",
        "SELECT 1 FROM analytics.metric_daily",
      ]) {
        expect(await stateOf(pool, sql, [], web()), sql).toBe("42501");
      }
      for (const sql of [
        "INSERT INTO audit.audit_log (actor_kind, action, row_hash) VALUES ('SYSTEM', 'x', '\\x00')",
        "INSERT INTO analytics.event (event_id, type, occurred_at, props) VALUES (gen_random_uuid(), 't', now(), '{}')",
      ]) {
        expect(await stateOf(pool, sql, [], web()), sql).toBe("no error");
      }
    });

    it("review fix (outbox forgery): no application role inserts outbox events; only definer functions and the owner write them", async () => {
      const insert =
        "INSERT INTO audit.outbox (event_id, type, aggregate_id, payload, payload_version) VALUES (gen_random_uuid(), 'purchase_completed', gen_random_uuid(), '{}', 1)";
      for (const role of ["app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"]) {
        expect(await stateOf(pool, insert, [], { role, userId: f.a.userId }), role).toBe("42501");
      }
      const { rows } = await pool.query<{ r: string }>(
        `SELECT r FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r
          WHERE has_any_column_privilege(r, 'audit.outbox', 'INSERT')`,
      );
      expect(rows).toEqual([]);
      // sixth review (0047): no direct outbox privilege at all for app_jobs (the relay, when it is
      // built, marks events through its own definer function)
      expect(
        await stateOf(pool, "UPDATE audit.outbox SET relayed_at = now() WHERE id = -1", [], {
          role: "app_jobs",
        }),
      ).toBe("42501");
    });

    it("app_web sees only published product versions (plus its own company's drafts)", async () => {
      const ids = [f.publishedVersion, f.draftVersion];
      const q = "SELECT count(*) AS n FROM core.product_version WHERE id = ANY($1)";
      expect(await asActor(pool, web(), (c) => countRows(c, q, [ids]))).toBe(1);
      expect(await asActor(pool, { role: "app_web", userId: f.seller }, (c) => countRows(c, q, [ids]))).toBe(
        2,
      );
      // naming the company in a setting is not ownership
      expect(
        await asActor(pool, web(), async (c) => {
          await c.query("SELECT set_config('app.company_id', $1, true)", [f.company]);
          return countRows(c, q, [ids]);
        }),
      ).toBe(1);
    });

    it("npc_worker sees only published product versions and nothing else in core", async () => {
      const q = "SELECT count(*) AS n FROM core.product_version WHERE id = ANY($1)";
      expect(
        await asActor(pool, { role: "npc_worker" }, (c) =>
          countRows(c, q, [[f.publishedVersion, f.draftVersion]]),
        ),
      ).toBe(1);
      expect(await stateOf(pool, "SELECT 1 FROM core.product", [], { role: "npc_worker" })).toBe("42501");
    });
  });

  describe("finding 3: wallets always equal their postings at commit", () => {
    it("app_web and app_pay cannot raise a wallet at all; a writer the grants missed not without postings", async () => {
      const raise = (c: pg.PoolClient) =>
        c.query(
          "UPDATE ledger.wallet SET available_paise = available_paise + 1000000 WHERE account_id = $1",
          [f.a.ledgerAccountId],
        );
      expect(await commitState(pool, web(), raise)).toBe("42501");
      expect(await commitState(pool, payRole(), raise)).toBe("42501");
      expect(await commitState(pool, raw(), raise)).toBe("23514");
    });

    it("not even the owner can change a wallet without postings", async () => {
      const message = await commitError(pool, {}, (c) =>
        c.query("UPDATE ledger.wallet SET available_paise = available_paise - 1 WHERE account_id = $1", [
          f.a.ledgerAccountId,
        ]),
      );
      expect(message).toMatch(/wallet .* does not equal/);
    });

    it("a wallet change matched by a balanced journal commits", async () => {
      // (an owner REVERSAL: app_pay's own debits are PURCHASEs, which need a whole order group,
      // its unbacked fee journals are refused, 0014, and no other role may post admin types)
      const state = await commitState(pool, {}, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'REVERSAL', 1)",
          [j],
        );
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -700, 'buy'), ($1, $3, 700, 'buy')",
          [j, f.a.ledgerAccountId, SINK_ACCOUNT_ID],
        );
        await c.query(
          "UPDATE ledger.wallet SET available_paise = available_paise - 700 WHERE account_id = $1",
          [f.a.ledgerAccountId],
        );
      });
      expect(state).toBe("no error");
    });

    it("a buyer's pay transaction credits a seller wallet through ledger.sync_wallets, without reading it", async () => {
      const buyer = await user(pool);
      const s = await seller(pool);
      const p = await product(pool, { seller: s, mode: "STANDARD_STOCKED", pricePaise: 900n * RUPEE });
      const before = await wallet(pool, s.owner.ledgerAccountId);
      await payFor(pool, buyer, await checkout(pool, buyer, [p], standard(s)));
      expect(await wallet(pool, s.owner.ledgerAccountId)).toBe(before + 855n * RUPEE);
      // still invisible to the buyer, in either role
      for (const role of ["app_web", "app_pay"]) {
        const seen = await asActor(pool, { role, userId: buyer.userId }, (c) =>
          countRows(c, "SELECT count(*) AS n FROM ledger.wallet WHERE account_id = $1", [
            s.owner.ledgerAccountId,
          ]),
        );
        expect(seen, role).toBe(0);
      }
    });

    it("wallets exist only for USER accounts", async () => {
      const message = await commitError(pool, {}, (c) =>
        c.query("INSERT INTO ledger.wallet (account_id, available_paise) VALUES ($1, 0)", [MINT_ACCOUNT_ID]),
      );
      expect(message).toMatch(/USER/);
    });
  });

  describe("finding 4: journal structure", () => {
    const journal = async (c: pg.PoolClient, type: string, postings: [string, number][]) => {
      const j = uuidv7();
      await c.query("INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, $2, 1)", [
        j,
        type,
      ]);
      for (const [account, amount] of postings) {
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, $3, 'x')",
          [j, account, amount],
        );
      }
      // Wallets must reflect postings at commit (0014), so the outcome is decided by the
      // event-type rules under test, not by a missing wallet update.
      const users = postings
        .map(([account]) => account)
        .filter((a) => a !== MINT_ACCOUNT_ID && a !== SINK_ACCOUNT_ID);
      if (users.length > 0) await c.query("SELECT ledger.sync_wallets($1)", [users]);
      return j;
    };

    it("postings cannot be added to a journal created in an earlier transaction", async () => {
      expect(
        await stateOf(
          pool,
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -5, 'x'), ($1, $3, 5, 'x')",
          [f.a.starterJournalId, MINT_ACCOUNT_ID, f.a.ledgerAccountId],
          web(),
        ),
      ).toBe("42501");
      const post = (c: pg.PoolClient) =>
        sqlState(
          c.query(
            "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -5, 'x'), ($1, $3, 5, 'x')",
            [f.a.starterJournalId, MINT_ACCOUNT_ID, f.a.ledgerAccountId],
          ),
        );
      expect(await asActor(pool, payRole(), post)).toBe("42501");
      expect(await asActor(pool, raw(), post)).toBe("23514");
      const asOwner = await commitError(pool, {}, (c) =>
        c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -5, 'x'), ($1, $3, 5, 'x')",
          [f.a.starterJournalId, MINT_ACCOUNT_ID, f.a.ledgerAccountId],
        ),
      );
      // a committed journal was checked at its commit, so its seal (0016 R9) refuses first; the
      // earlier-transaction rule (0003) stands behind it
      expect(asOwner).toMatch(/sealed|earlier transaction/);
    });

    it("journal.created_txid is always the inserting transaction, whatever the inserter supplies", async () => {
      const same = await asActor(pool, {}, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version, created_txid) VALUES ($1, 'PURCHASE', 1, txid_current() + 1000)",
          [j],
        );
        const { rows } = await c.query<{ same: boolean }>(
          "SELECT created_txid = txid_current() AS same FROM ledger.journal WHERE id = $1",
          [j],
        );
        return rows[0]?.same;
      });
      expect(same).toBe(true);
    });

    it("a journal needs at least two postings at commit", async () => {
      expect(await commitError(pool, raw(), (c) => journal(c, "PURCHASE", []))).toMatch(
        /at least two postings/,
      );
    });

    const cases: [string, string, (x: Fixture) => [string, number][], string][] = [
      [
        "COMPENSATION crediting MINT",
        "COMPENSATION",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [MINT_ACCOUNT_ID, 5],
        ],
        "reject",
      ],
      [
        "COMPENSATION to two users",
        "COMPENSATION",
        (x) => [
          [MINT_ACCOUNT_ID, -10],
          [x.a.ledgerAccountId, 5],
          [x.b.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        "COMPENSATION via SINK",
        "COMPENSATION",
        (x) => [
          [SINK_ACCOUNT_ID, -5],
          [x.a.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        "COMPENSATION MINT to one user",
        "COMPENSATION",
        (x) => [
          [MINT_ACCOUNT_ID, -5],
          [x.a.ledgerAccountId, 5],
        ],
        "accept",
      ],
      [
        "RELIEF_GRANT debiting a user",
        "RELIEF_GRANT",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [x.b.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        "ACCOUNT_RETIREMENT into MINT",
        "ACCOUNT_RETIREMENT",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [MINT_ACCOUNT_ID, 5],
        ],
        "reject",
      ],
      [
        "ACCOUNT_RETIREMENT to another user",
        "ACCOUNT_RETIREMENT",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [x.b.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        "ACCOUNT_RETIREMENT into SINK",
        "ACCOUNT_RETIREMENT",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [SINK_ACCOUNT_ID, 5],
        ],
        "accept",
      ],
      [
        "PURCHASE crediting MINT",
        "PURCHASE",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [MINT_ACCOUNT_ID, 5],
        ],
        "reject",
      ],
      [
        "PURCHASE debiting SINK",
        "PURCHASE",
        (x) => [
          [SINK_ACCOUNT_ID, -5],
          [x.a.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        // since 0016 a PURCHASE must be a whole, correctly priced order (tests/money-attacks)
        "PURCHASE user to user and SINK without an order group",
        "PURCHASE",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [x.b.ledgerAccountId, 4],
          [SINK_ACCOUNT_ID, 1],
        ],
        "reject",
      ],
      [
        "MEMBERSHIP minting",
        "MEMBERSHIP",
        (x) => [
          [MINT_ACCOUNT_ID, -5],
          [x.a.ledgerAccountId, 5],
        ],
        "reject",
      ],
      [
        "MEMBERSHIP paid from the user's own wallet to SINK",
        "MEMBERSHIP",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [SINK_ACCOUNT_ID, 5],
        ],
        "accept",
      ],
      [
        "MEMBERSHIP paid from another user's wallet",
        "MEMBERSHIP",
        (x) => [
          [x.b.ledgerAccountId, -5],
          [SINK_ACCOUNT_ID, 5],
        ],
        "reject",
      ],
      [
        "REVERSAL debiting SINK",
        "REVERSAL",
        (x) => [
          [SINK_ACCOUNT_ID, -5],
          [x.a.ledgerAccountId, 5],
        ],
        "accept",
      ],
      [
        "REVERSAL crediting MINT",
        "REVERSAL",
        (x) => [
          [x.a.ledgerAccountId, -5],
          [MINT_ACCOUNT_ID, 5],
        ],
        "accept",
      ],
    ];
    // Admin journal types are inserted only by the database owner (0016). No application role
    // inserts the rest (the command functions of 0018 do), so their account rules are exercised
    // by a writer the grants did not stop. The unbacked fee types (MEMBERSHIP, ...) are checked
    // as the owner acting for user A, the path they will take once they are backed.
    const ADMIN_TYPES = ["COMPENSATION", "REVERSAL", "ACCOUNT_RETIREMENT"];
    const UNBACKED_TYPES = ["COMPANY_REGISTRATION", "WAREHOUSE_PURCHASE", "MEMBERSHIP"];
    for (const [label, type, postings, expected] of cases) {
      it(`event-type account rules: ${label} is ${expected}ed`, async () => {
        const actor = ADMIN_TYPES.includes(type)
          ? {}
          : UNBACKED_TYPES.includes(type)
            ? { userId: f.a.userId }
            : raw();
        const state = await commitState(pool, actor, (c) => journal(c, type, postings(f)));
        expect(state === "no error" ? "accept" : `reject:${state}`).toBe(
          expected === "accept" ? "accept" : "reject:23514",
        );
      });
    }
  });

  describe("finding 5: per-table, per-column privileges and CHECKs", () => {
    it("app_web and app_pay cannot change any profile column: role, test flag, status, fingerprints, handle", async () => {
      for (const role of ["app_web", "app_pay"]) {
        for (const set of [
          "role = 'SUPER_ADMIN'",
          "is_test_account = true",
          "status = 'SUSPENDED'",
          "email_fingerprint = '\\x00'",
          "phone_fingerprint = '\\x00'",
          "is_adult = true",
          "handle = 'player-a'",
          "provisioned_at = now()",
        ]) {
          const sql = `UPDATE core.user_profile SET ${set} WHERE id = $1`;
          expect(await stateOf(pool, sql, [f.a.userId], { role, userId: f.a.userId }), `${role} ${set}`).toBe(
            "42501",
          );
        }
      }
    });

    it("no application role can create a profile, not even its own ordinary one (only core.provision_account)", async () => {
      const fresh = uuidv7();
      const insert = (cols: string, vals: string, id: string, role: string) =>
        stateOf(
          pool,
          `INSERT INTO core.user_profile (id, email_fingerprint${cols}) VALUES ($1, $2${vals})`,
          [id, randomBytes(32)],
          { role, userId: fresh },
        );
      for (const role of ["app_web", "app_pay", "app_jobs"]) {
        expect(await insert(", role", ", 'SUPER_ADMIN'", fresh, role), role).toBe("42501");
        expect(await insert(", is_test_account", ", true", fresh, role), role).toBe("42501");
        expect(await insert("", "", uuidv7(), role), role).toBe("42501");
        expect(await insert("", "", fresh, role), role).toBe("42501");
      }
    });

    it("app_web and app_pay hold no INSERT or UPDATE on any user_profile column", async () => {
      const { rows } = await pool.query<{ r: string; column_name: string }>(
        `SELECT r, column_name FROM information_schema.columns, unnest(ARRAY['app_web','app_pay']) r
          WHERE table_schema = 'core' AND table_name = 'user_profile'
            AND (has_column_privilege(r, 'core.user_profile', column_name, 'UPDATE')
              OR has_column_privilege(r, 'core.user_profile', column_name, 'INSERT'))
          ORDER BY 1, 2`,
      );
      expect(rows).toEqual([]);
    });

    it("app_web, app_pay and app_jobs have DELETE on no core or ledger table (sixth review: not even the jobs' former retention tables)", async () => {
      const { rows } = await pool.query<{ r: string; t: string }>(
        `SELECT r, c.oid::regclass::text AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['app_web','app_pay','app_jobs']) r
          WHERE n.nspname IN ('core','ledger') AND c.relkind IN ('r','p')
            AND (has_table_privilege(r, c.oid, 'DELETE') OR has_table_privilege(r, c.oid, 'TRUNCATE'))
          ORDER BY 1, 2`,
      );
      // idempotency records are purged through core.purge_idempotency_records() (0018); the jobs'
      // direct DELETE on tombstones and coupon-lookup failures is revoked (0047)
      expect(rows).toEqual([]);
    });

    it("app_web cannot delete tombstones, orders, ownership, payments, grants or shipments", async () => {
      for (const t of [
        "core.identity_tombstone",
        "core.ownership",
        "core.order_group",
        "core.seller_order",
        "core.order_line",
        "core.payment_attempt",
        "core.checkout_session",
        "ledger.grant_record",
        "core.coupon_redemption",
        "core.shipment",
      ]) {
        expect(await stateOf(pool, `DELETE FROM ${t}`, [], web()), t).toBe("42501");
      }
      expect(await stateOf(pool, "DELETE FROM private.address WHERE user_id = $1", [f.a.userId], web())).toBe(
        "no error",
      );
    });

    it("app_jobs deletes no tombstone directly, expired or live (sixth review, 0047)", async () => {
      const live = randomBytes(32);
      const dead = randomBytes(32);
      await pool.query(
        "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'EMAIL', now() + interval '1 day'), ($2, 'EMAIL', now() - interval '1 day')",
        [live, dead],
      );
      expect(
        await stateOf(
          pool,
          "DELETE FROM core.identity_tombstone WHERE fingerprint = ANY($1)",
          [[live, dead]],
          {
            role: "app_jobs",
          },
        ),
      ).toBe("42501");
      expect(
        await countRows(
          pool,
          "SELECT count(*) AS n FROM core.identity_tombstone WHERE fingerprint = ANY($1)",
          [[live, dead]],
        ),
      ).toBe(2);
    });

    const negatives: [string, string, unknown[]][] = [
      [
        "order_group.total_paise",
        `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
         VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'PLAYER', -1, 1)`,
        [],
      ],
      ["seller_order.list_paise", "UPDATE core.seller_order SET list_paise = -1 WHERE id = $1", ["so"]],
      ["seller_order.fee_paise", "UPDATE core.seller_order SET fee_paise = -1 WHERE id = $1", ["so"]],
      ["seller_order.net_paise", "UPDATE core.seller_order SET net_paise = -1 WHERE id = $1", ["so"]],
      [
        "seller_order.seller_type",
        "UPDATE core.seller_order SET seller_type = 'BOGUS' WHERE id = $1",
        ["so"],
      ],
      [
        "order_line.list_paise",
        "UPDATE core.order_line SET list_paise = -1 WHERE seller_order_id = $1",
        ["so"],
      ],
      [
        "order_line.fee_paise",
        "UPDATE core.order_line SET fee_paise = -1 WHERE seller_order_id = $1",
        ["so"],
      ],
      ["coupon_redemption.discount_paise", "UPDATE core.coupon_redemption SET discount_paise = -1", []],
      ["grant_record.amount", "UPDATE ledger.grant_record SET amount = 0 WHERE type = 'RELIEF'", []],
      ["bank_account.status", "UPDATE core.bank_account SET status = 'BOGUS'", []],
      ["coupon.status", "UPDATE core.coupon SET status = 'BOGUS'", []],
      [
        "promo_campaign.status",
        "INSERT INTO core.promo_campaign (id, name, budget_paise, status) VALUES (gen_random_uuid(), 'x', 1, 'BOGUS')",
        [],
      ],
    ];
    for (const [label, sql, params] of negatives) {
      it(`CHECK: ${label}`, async () => {
        const resolved = params.map((p) => (p === "so" ? f.sellerOrderB : p));
        const state = await asActor(pool, {}, async (c) => {
          if (label.startsWith("grant_record")) {
            // a RELIEF grant to update (the table is append-only for app roles, not for the owner)
            await c.query(
              "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day) VALUES ($1, $2, $3, 'RELIEF', 5, '2026-01-01')",
              [uuidv7(), f.a.userId, await openJournal(c)],
            );
          }
          return sqlState(c.query(sql, resolved));
        });
        expect(state).toBe("23514");
      });
    }
  });

  describe("finding 6: tombstone lookup is done by the database, not the caller", () => {
    it("provisioning applies the tombstone rule itself; app_web and app_pay can neither read tombstones nor ask about a fingerprint", async () => {
      const fp = randomBytes(32);
      await pool.query(
        "INSERT INTO core.identity_tombstone (fingerprint, kind, expires_at) VALUES ($1, 'PHONE', now() + interval '1 day')",
        [fp],
      );
      for (const role of ["app_web", "app_pay"]) {
        expect(await stateOf(pool, "SELECT 1 FROM core.identity_tombstone", [], { role }), role).toBe(
          "42501",
        );
        expect(
          await stateOf(pool, "SELECT core.identity_is_tombstoned($1, $2)", [randomBytes(32), fp], { role }),
          role,
        ).toBe("42501");
      }
      // sixth review (0047): the job runner may not ask either (no job needs it); the owner can
      expect(
        await stateOf(pool, "SELECT core.identity_is_tombstoned($1, $2)", [randomBytes(32), fp], {
          role: "app_jobs",
        }),
      ).toBe("42501");
      const answer = await asActor(pool, {}, async (c) => {
        const { rows } = await c.query<{ email: boolean; phone: boolean; wrongKind: boolean }>(
          `SELECT core.identity_is_tombstoned($1, NULL) AS email, core.identity_is_tombstoned($1, $2) AS phone,
                  core.identity_is_tombstoned($2, $1) AS "wrongKind"`,
          [randomBytes(32), fp],
        );
        return rows[0];
      });
      expect(answer).toEqual({ email: false, phone: true, wrongKind: false });
    });
  });

  describe("finding 8: foreign keys", () => {
    it("grant_record.user_id must reference a profile", async () => {
      expect(
        await asActor(pool, {}, async (c) =>
          sqlState(
            c.query(
              "INSERT INTO ledger.grant_record (id, user_id, journal_id, type, amount, utc_day) VALUES ($1, $2, $3, 'RELIEF', 5, '2026-01-02')",
              [uuidv7(), uuidv7(), await openJournal(c)],
            ),
          ),
        ),
      ).toBe("23503");
    });

    it("posting.seller_order_id and journal.order_group_id must reference real rows (checked at commit)", async () => {
      // (a MEMBERSHIP fee of the acting user: a PURCHASE would first fail for want of its order)
      const posting = await commitState(pool, { userId: f.a.userId }, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version) VALUES ($1, 'MEMBERSHIP', 1)",
          [j],
        );
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo, seller_order_id) VALUES ($1, $2, -5, 'x', $4), ($1, $3, 5, 'x', $4)",
          [j, f.a.ledgerAccountId, SINK_ACCOUNT_ID, uuidv7()],
        );
      });
      expect(posting).toBe("23503");
      const journal = await commitState(pool, {}, async (c) => {
        const j = uuidv7();
        await c.query(
          "INSERT INTO ledger.journal (id, event_type, config_version, order_group_id) VALUES ($1, 'PURCHASE', 1, $2)",
          [j, uuidv7()],
        );
        await c.query(
          "INSERT INTO ledger.posting (journal_id, account_id, amount, memo) VALUES ($1, $2, -5, 'x'), ($1, $3, 5, 'x')",
          [j, f.a.ledgerAccountId, SINK_ACCOUNT_ID],
        );
      });
      expect(journal).toBe("23503");
    });
  });

  describe("finding 10: role attributes and database-level privileges", () => {
    it("app roles and PUBLIC have no TEMP or CREATE on the database and no CREATE on schema public", async () => {
      const { rows } = await pool.query<{ r: string; p: string }>(
        `SELECT r, p FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro','anon','authenticated']) r,
                unnest(ARRAY['TEMP','CREATE']) p
          WHERE has_database_privilege(r, current_database(), p)
         UNION ALL
         SELECT r, 'CREATE ON public' FROM unnest(ARRAY['app_web','app_pay','app_jobs','npc_worker','research_ro']) r
          WHERE has_schema_privilege(r, 'public', 'CREATE')`,
      );
      expect(rows).toEqual([]);
      const acl = await pool.query<{ acl: string | null }>(
        "SELECT datacl::text AS acl FROM pg_database WHERE datname = current_database()",
      );
      // PUBLIC (an empty grantee) holds no T or C
      expect(acl.rows[0]?.acl ?? "").not.toMatch(/(^|[{,])=[^/]*[TC]/);
    });

    it("app_web cannot create temporary tables", async () => {
      expect(await stateOf(pool, "CREATE TEMP TABLE t (x int)", [], { role: "app_web" })).toBe("42501");
    });

    it("an existing role with extra attributes is altered back on migration", async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      let scratch: TestDatabase | undefined;
      try {
        await admin.query("ALTER ROLE app_jobs CREATEDB CREATEROLE BYPASSRLS");
        scratch = await createTestDatabase();
        const { rows } = await admin.query(
          `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin FROM pg_roles
            WHERE rolname IN ('app_web','app_pay','app_jobs','npc_worker','research_ro','migrator') ORDER BY rolname`,
        );
        expect(rows).toEqual(
          ["app_jobs", "app_pay", "app_web", "migrator", "npc_worker", "research_ro"].map((rolname) => ({
            rolname,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
            rolcanlogin: rolname !== "migrator",
          })),
        );
      } finally {
        await admin.query("ALTER ROLE app_jobs NOCREATEDB NOCREATEROLE NOBYPASSRLS");
        await admin.end();
        await scratch?.drop();
      }
    });
  });
});
