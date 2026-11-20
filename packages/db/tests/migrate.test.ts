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

  it("concurrent runners serialise and apply each migration once", async () => {
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
});
