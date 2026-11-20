import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Arbitrary constant: serialises concurrent runners against the same database.
const MIGRATION_LOCK_KEY = 7_340_211_905;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrateOptions {
  directory?: string;
}

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((n) => n.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match?.[1]) throw new Error(`Migration file name must look like NNNN_name.sql: ${name}`);
    const version = match[1];
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
    const sql = await readFile(join(directory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    files.push({ version, name, sql, checksum });
  }
  return files;
}

/**
 * Applies pending forward-only migrations in file-name order, each in its own
 * transaction, recording them in public.schema_migrations. Idempotent: applied
 * files are skipped; an applied file whose content changed is an error.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrationResult> {
  const files = await loadMigrations(options.directory ?? MIGRATIONS_DIR);
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM public.schema_migrations",
      );
      const applied = new Map(rows.map((r) => [r.version, r.checksum]));
      for (const file of files) {
        const existing = applied.get(file.version);
        if (existing !== undefined) {
          if (existing !== file.checksum) {
            throw new Error(`Migration ${file.name} was changed after it was applied; add a new migration instead`);
          }
          result.skipped.push(file.name);
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(file.sql);
          await client.query("INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
            file.version,
            file.name,
            file.checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
        }
        result.applied.push(file.name);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return result;
}
