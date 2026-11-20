import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate";
import { createTestDatabase, type TestDatabase } from "./helpers";

describe("migration runner", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await db.drop();
  });

  it("migrations apply cleanly twice: the second run applies nothing (idempotent runner)", async () => {
    const first = await migrate(db.pool);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.skipped).toEqual([]);
    const second = await migrate(db.pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
    const { rows } = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM public.schema_migrations");
    expect(Number(rows[0]?.n)).toBe(first.applied.length);
  });

  it("concurrent runners on an empty database serialise and apply each migration exactly once", async () => {
    const empty = await createTestDatabase({ migrate: false, poolSize: 4 });
    try {
      const results = await Promise.all([migrate(empty.pool), migrate(empty.pool)]);
      const total = results[0].applied.length + results[0].skipped.length;
      expect(total).toBeGreaterThan(0);
      // exactly one runner applied everything; the other found it all applied
      const appliedCounts = results.map((r) => r.applied.length).sort((x, y) => x - y);
      expect(appliedCounts).toEqual([0, total]);
      const { rows } = await empty.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM public.schema_migrations",
      );
      expect(Number(rows[0]?.n)).toBe(total);
      const accounts = await empty.pool.query("SELECT 1 FROM ledger.ledger_account WHERE type <> 'USER'");
      expect(accounts.rowCount).toBe(2);
    } finally {
      await empty.drop();
    }
  });

  it("re-running against a migrated database applies nothing, even with three runners at once", async () => {
    const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
    for (const r of results) expect(r.applied).toEqual([]);
  });

  it("seed migration creates config_version 1 and exactly one MINT and one SINK account", async () => {
    const cfg = await db.pool.query<{ id: number; starter: string }>(
      "SELECT id, values->>'starter_grant_paise' AS starter FROM core.config_version",
    );
    expect(cfg.rows).toEqual([{ id: 1, starter: "100000000000" }]);
    const acc = await db.pool.query<{ type: string }>(
      "SELECT type FROM ledger.ledger_account WHERE type <> 'USER' ORDER BY type",
    );
    expect(acc.rows.map((r) => r.type)).toEqual(["MINT", "SINK"]);
  });

  it("a failing migration rolls back entirely and is not recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "delulu-migrations-"));
    await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE public.runner_probe (id int);");
    await writeFile(join(dir, "0002_bad.sql"), "CREATE TABLE public.runner_probe2 (id int); SELECT 1/0;");
    const scratch = await createTestDatabase({ migrate: false });
    try {
      await expect(migrate(scratch.pool, { directory: dir })).rejects.toThrow(/0002_bad\.sql failed/);
      const { rows } = await scratch.pool.query<{ version: string }>(
        "SELECT version FROM public.schema_migrations",
      );
      expect(rows.map((r) => r.version)).toEqual(["0001"]);
      const probe = await scratch.pool.query("SELECT to_regclass('public.runner_probe2') AS t");
      expect(probe.rows[0]?.t).toBeNull();
      await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE public.runner_probe (id bigint);");
      await expect(migrate(scratch.pool, { directory: dir })).rejects.toThrow(/changed after it was applied/);
    } finally {
      await scratch.drop();
    }
  });

  for (const [label, body] of [
    ["COMMIT", "CREATE TABLE public.tc_probe (id int);\nCOMMIT;\nCREATE TABLE public.tc_probe2 (id int);"],
    ["BEGIN", "BEGIN;\nCREATE TABLE public.tc_probe (id int);"],
    ["ROLLBACK", "CREATE TABLE public.tc_probe (id int); rollback ;"],
    ["START TRANSACTION", "start transaction isolation level serializable; SELECT 1;"],
    ["END", "SELECT 1; END;"],
  ] as const) {
    it(`a migration containing statement-level ${label} is rejected before anything runs`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "delulu-migrations-"));
      await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE public.tc_ok (id int);");
      await writeFile(join(dir, "0002_tx.sql"), body);
      const scratch = await createTestDatabase({ migrate: false });
      try {
        await expect(migrate(scratch.pool, { directory: dir })).rejects.toThrow(
          /0002_tx\.sql contains transaction control/,
        );
        const probe = await scratch.pool.query("SELECT to_regclass('public.tc_ok') AS t");
        expect(probe.rows[0]?.t).toBeNull();
      } finally {
        await scratch.drop();
      }
    });
  }

  it("BEGIN inside function bodies, DO blocks, strings, comments and BEGIN ATOMIC is not transaction control", async () => {
    const dir = await mkdtemp(join(tmpdir(), "delulu-migrations-"));
    await writeFile(
      join(dir, "0001_bodies.sql"),
      [
        "-- BEGIN; COMMIT; in a comment",
        "/* ROLLBACK; */",
        "CREATE FUNCTION public.f1() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;",
        "CREATE FUNCTION public.f2() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 2; END; $body$;",
        "DO $$ BEGIN PERFORM 1; END $$;",
        "CREATE FUNCTION public.f3() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 3; END;",
        'SELECT \'COMMIT;\' AS s, "end" FROM (SELECT 1 AS "end") x;',
      ].join("\n"),
    );
    const scratch = await createTestDatabase({ migrate: false });
    try {
      const r = await migrate(scratch.pool, { directory: dir });
      expect(r.applied).toEqual(["0001_bodies.sql"]);
    } finally {
      await scratch.drop();
    }
  });
});
