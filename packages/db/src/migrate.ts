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

// Statement-level transaction control. The runner wraps each file in one
// transaction; a COMMIT inside a file would commit half a migration and leave the
// rest running outside any transaction, unrecorded.
const TRANSACTION_CONTROL = /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i;

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * Splits SQL into top-level statements, with comments, string literals, quoted
 * identifiers and dollar-quoted bodies (function bodies, DO blocks) blanked out, so
 * that only real statement keywords remain. SQL-standard `BEGIN ATOMIC ... END`
 * function bodies are kept inside their CREATE statement.
 */
export function topLevelStatements(sql: string): string[] {
  const segments: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    const rest = sql.slice(i, i + 2);
    if (rest === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      current += " ";
    } else if (rest === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      current += " ";
    } else if (ch === "'" || ch === '"') {
      const prev = i > 0 ? sql.charAt(i - 1) : "";
      const backslashEscapes =
        ch === "'" && /[eE]/.test(prev) && !IDENTIFIER_CHAR.test(sql.charAt(i - 2) || " ");
      i += 1;
      while (i < sql.length) {
        const c = sql.charAt(i);
        if (backslashEscapes && c === "\\") i += 2;
        else if (c === ch && sql.charAt(i + 1) === ch) i += 2;
        else if (c === ch) {
          i += 1;
          break;
        } else i += 1;
      }
      current += ch === "'" ? "''" : '"x"';
    } else if (ch === "$" && !IDENTIFIER_CHAR.test(i > 0 ? sql.charAt(i - 1) : " ")) {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        current += "$$";
      } else {
        current += ch;
        i += 1;
      }
    } else if (ch === ";") {
      segments.push(current);
      current = "";
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  segments.push(current);

  const statements: string[] = [];
  for (let k = 0; k < segments.length; k++) {
    let statement = segments[k]?.trim() ?? "";
    if (/\bBEGIN\s+ATOMIC\b/i.test(statement)) {
      while (k + 1 < segments.length) {
        k += 1;
        const part = segments[k]?.trim() ?? "";
        statement += `; ${part}`;
        if (/^END$/i.test(part)) break;
      }
    }
    if (statement !== "") statements.push(statement);
  }
  return statements;
}

function assertNoTransactionControl(name: string, sql: string): void {
  topLevelStatements(sql).forEach((statement, index) => {
    const match = TRANSACTION_CONTROL.exec(statement);
    if (match?.[1]) {
      throw new Error(
        `Migration ${name} contains transaction control (${match[1].toUpperCase().replace(/\s+/g, " ")}) ` +
          `in statement ${index + 1}; the runner wraps each file in its own transaction, so remove it`,
      );
    }
  });
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
    assertNoTransactionControl(name, sql);
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
            throw new Error(
              `Migration ${file.name} was changed after it was applied; add a new migration instead`,
            );
          }
          result.skipped.push(file.name);
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(file.sql);
          await client.query(
            "INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
            [file.version, file.name, file.checksum],
          );
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
