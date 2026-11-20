import { randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../src/transaction";
import {
  createProfile,
  createTestDatabase,
  plant,
  provisionAccount,
  provisionInput,
  stateOf,
  type TestDatabase,
  uuidv7,
} from "./helpers";

const APP_SCHEMAS = ["core", "ledger", "private", "sandbox", "analytics", "audit", "research"];

describe("roles, grants and row-level security", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    userA = await createProfile(pool);
    userB = await createProfile(pool);
    for (const u of [userA, userB]) {
      await pool.query(
        "INSERT INTO private.address (id, user_id, kind, label, payload_enc) VALUES ($1, $2, 'REAL', 'HOME', $3)",
        [uuidv7(), u, randomBytes(48)],
      );
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  it("RLS: as app_web with app.user_id = A, addresses of user B are invisible", async () => {
    const rows = await withTransaction(
      pool,
      async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        return (await c.query<{ user_id: string }>("SELECT user_id FROM private.address")).rows;
      },
      { userId: userA },
    );
    expect(rows).toEqual([{ user_id: userA }]);
    const updated = await withTransaction(
      pool,
      async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        return (await c.query("UPDATE private.address SET label = 'WORK' WHERE user_id = $1", [userB]))
          .rowCount;
      },
      { userId: userA },
    );
    expect(updated).toBe(0);
  });

  it("RLS: as app_web with app.user_id = A, an address cannot be inserted for user B", async () => {
    const insert =
      "INSERT INTO private.address (id, user_id, kind, label, payload_enc) VALUES ($1, $2, 'REAL', 'HOME', '\\x01')";
    expect(await stateOf(pool, insert, [uuidv7(), userB], { role: "app_web", userId: userA })).toBe("42501");
    expect(await stateOf(pool, insert, [uuidv7(), userA], { role: "app_web", userId: userA })).toBe(
      "no error",
    );
  });

  it("RLS: without app.user_id, app_web sees no addresses (fails closed, no error)", async () => {
    const rows = await withTransaction(pool, async (c) => {
      await c.query("SET LOCAL ROLE app_web");
      return (await c.query("SELECT 1 FROM private.address")).rowCount;
    });
    expect(rows).toBe(0);
  });

  it("RLS: owner policies hide another user's bank account, card, wallet-linked records and seller orders", async () => {
    const a = await provisionAccount(pool, provisionInput({ userId: uuidv7() }));
    const b = await provisionAccount(pool, provisionInput({ userId: uuidv7() }));
    const company = uuidv7();
    const group = uuidv7();
    // visibility fixture only: an order without its journal, session or attempt is impossible
    // under the money rules (0016), so it is planted with triggers and foreign keys off
    await plant(pool, async (c) => {
      await c.query(
        `INSERT INTO core.order_group (id, buyer_user_id, session_id, payment_attempt_id, journal_id, buyer_source, total_paise, config_version)
         VALUES ($1, $2, $3, $4, $5, 'PLAYER', 10000, 1)`,
        [group, b.userId, uuidv7(), uuidv7(), uuidv7()],
      );
      await c.query(
        `INSERT INTO core.seller_order (id, order_group_id, buyer_user_id, company_id, seller_type, list_paise, fee_paise, net_paise)
         VALUES ($1, $2, $3, $4, 'USER', 10000, 500, 9500)`,
        [uuidv7(), group, b.userId, company],
      );
    });
    const seen = await withTransaction(
      pool,
      async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        const count = async (sql: string) => Number((await c.query<{ n: string }>(sql)).rows[0]?.n);
        return {
          bank: await count("SELECT count(*) AS n FROM core.bank_account"),
          cards: await count("SELECT count(*) AS n FROM core.virtual_card"),
          wallets: await count("SELECT count(*) AS n FROM ledger.wallet"),
          ownWallet: await count(
            `SELECT count(*) AS n FROM ledger.wallet WHERE account_id = '${a.ledgerAccountId}'`,
          ),
          otherWallet: await count(
            `SELECT count(*) AS n FROM ledger.wallet WHERE account_id = '${b.ledgerAccountId}'`,
          ),
          userAccounts: await count("SELECT count(*) AS n FROM ledger.ledger_account WHERE type = 'USER'"),
          postings: await count("SELECT count(*) AS n FROM ledger.posting"),
          otherPostings: await count(
            `SELECT count(*) AS n FROM ledger.posting WHERE account_id = '${b.ledgerAccountId}'`,
          ),
          grants: await count("SELECT count(*) AS n FROM ledger.grant_record"),
          groups: await count("SELECT count(*) AS n FROM core.order_group"),
          sellerOrders: await count("SELECT count(*) AS n FROM core.seller_order"),
        };
      },
      { userId: a.userId },
    );
    expect(seen).toEqual({
      bank: 1,
      cards: 1,
      wallets: 1,
      ownWallet: 1,
      otherWallet: 0,
      userAccounts: 1,
      postings: 1,
      otherPostings: 0,
      grants: 1,
      groups: 0,
      sellerOrders: 0,
    });
    const asSeller = await withTransaction(
      pool,
      async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        return (await c.query("SELECT 1 FROM core.seller_order")).rowCount;
      },
      { userId: a.userId, companyId: company },
    );
    expect(asSeller).toBe(1);
  });

  it("app_web cannot read private.user_secret of another user", async () => {
    await pool.query(
      "INSERT INTO private.user_secret (user_id, birthdate_enc) VALUES ($1, '\\x01'), ($2, '\\x02')",
      [userA, userB],
    );
    const rows = await withTransaction(
      pool,
      async (c) => {
        await c.query("SET LOCAL ROLE app_web");
        return (await c.query<{ user_id: string }>("SELECT user_id FROM private.user_secret")).rows;
      },
      { userId: userA },
    );
    expect(rows).toEqual([{ user_id: userA }]);
  });

  it("private schema is web-only: app_jobs, npc_worker and research_ro cannot read it", async () => {
    for (const role of ["app_jobs", "npc_worker", "research_ro"]) {
      expect(await stateOf(pool, "SELECT 1 FROM private.address", [], { role })).toBe("42501");
    }
  });

  it("npc_worker cannot read or write ledger tables", async () => {
    const statements = [
      "SELECT 1 FROM ledger.posting",
      "SELECT 1 FROM ledger.journal",
      "SELECT 1 FROM ledger.wallet",
      "SELECT 1 FROM ledger.ledger_account",
      "SELECT 1 FROM ledger.grant_record",
      "INSERT INTO ledger.journal (id, event_type, config_version) VALUES (gen_random_uuid(), 'COMPENSATION', 1)",
      "UPDATE ledger.wallet SET available_paise = 0",
    ];
    for (const sql of statements) {
      expect(await stateOf(pool, sql, [], { role: "npc_worker" }), sql).toBe("42501");
    }
    const { rows } = await pool.query<{ t: string; p: string }>(
      `SELECT c.oid::regclass::text AS t, p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
        WHERE n.nspname = 'ledger' AND c.relkind IN ('r','p') AND has_table_privilege('npc_worker', c.oid, p)`,
    );
    expect(rows).toEqual([]);
  });

  it("invariant 9: npc_worker cannot write orders or inventory, only sandbox", async () => {
    expect(await stateOf(pool, "SELECT 1 FROM core.order_group", [], { role: "npc_worker" })).toBe("42501");
    expect(
      await stateOf(pool, "UPDATE core.product SET available_units = 0", [], { role: "npc_worker" }),
    ).toBe("42501");
    expect(await stateOf(pool, "SELECT 1 FROM core.product_version", [], { role: "npc_worker" })).toBe(
      "no error",
    );
    expect(
      await stateOf(
        pool,
        "INSERT INTO sandbox.npc_actor (id, persona) VALUES (gen_random_uuid(), 'bargain hunter')",
        [],
        {
          role: "npc_worker",
        },
      ),
    ).toBe("no error");
    for (const role of ["app_web", "app_jobs"]) {
      expect(await stateOf(pool, "SELECT 1 FROM sandbox.npc_actor", [], { role })).toBe("42501");
    }
  });

  it("anon and authenticated have no privileges on any application table, sequence or schema", async () => {
    const tables = await pool.query<{ role: string; t: string; p: string; has: boolean }>(
      `SELECT r AS role, c.oid::regclass::text AS t, p, has_table_privilege(r, c.oid, p) AS has
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              unnest(ARRAY['anon','authenticated']) r,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','v','m','f')`,
      [APP_SCHEMAS],
    );
    const distinctTables = new Set(tables.rows.map((r) => r.t));
    expect(distinctTables.size).toBeGreaterThanOrEqual(40);
    expect(tables.rows.filter((r) => r.has)).toEqual([]);

    const seqs = await pool.query<{ t: string }>(
      `SELECT c.oid::regclass::text AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['anon','authenticated']) r
        WHERE n.nspname = ANY($1) AND c.relkind = 'S'
          AND (has_sequence_privilege(r, c.oid, 'USAGE') OR has_sequence_privilege(r, c.oid, 'SELECT'))`,
      [APP_SCHEMAS],
    );
    expect(seqs.rows).toEqual([]);

    const schemas = await pool.query<{ s: string }>(
      `SELECT s FROM unnest($1::text[]) s, unnest(ARRAY['anon','authenticated']) r
        WHERE has_schema_privilege(r, s, 'USAGE') OR has_schema_privilege(r, s, 'CREATE')`,
      [APP_SCHEMAS],
    );
    expect(schemas.rows).toEqual([]);

    const grants = await pool.query(
      `SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee IN ('anon','authenticated','PUBLIC') AND table_schema = ANY($1)`,
      [APP_SCHEMAS],
    );
    expect(grants.rows).toEqual([]);
  });

  it("ledger grants: read-only for app_web, insert-only for app_pay and app_jobs, wallet updatable, nothing for research_ro", async () => {
    const { rows } = await pool.query<{ r: string; t: string; p: string; has: boolean }>(
      `SELECT r, t, p, has_table_privilege(r, t, p) AS has
         FROM unnest(ARRAY['app_web','app_pay','app_jobs','research_ro']) r,
              unnest(ARRAY['ledger.journal','ledger.posting','ledger.grant_record','ledger.wallet']) t,
              unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
    );
    const held = rows.filter((x) => x.has).map((x) => `${x.r} ${x.p} ${x.t}`);
    expect(held.sort()).toEqual(
      [
        "app_web SELECT ledger.journal",
        "app_web SELECT ledger.posting",
        "app_web SELECT ledger.grant_record",
        "app_web SELECT ledger.wallet",
        ...["app_pay", "app_jobs"].flatMap((r) => [
          `${r} SELECT ledger.journal`,
          `${r} INSERT ledger.journal`,
          `${r} SELECT ledger.posting`,
          `${r} INSERT ledger.posting`,
          `${r} SELECT ledger.grant_record`,
          `${r} INSERT ledger.grant_record`,
          `${r} SELECT ledger.wallet`,
          `${r} INSERT ledger.wallet`,
          `${r} UPDATE ledger.wallet`,
        ]),
      ].sort(),
    );
  });
});
