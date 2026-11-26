import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * R16.6, US-60: the local helper that makes waiting delayed actions due (scripts/dev-expedite-admin-actions.ts)
 * must never work on a database or a server that is not on this machine, nor in production: the
 * 24-hour delay is the safeguard against a stolen session, so no switch may shorten it elsewhere.
 * It is an owner-only script; there is no route for it.
 */
const SCRIPT = new URL("../../../scripts/dev-expedite-admin-actions.ts", import.meta.url).pathname;
const RESOLVE = new URL("../../../scripts/ts-resolve.mjs", import.meta.url).pathname;

function run(env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--import", RESOLVE, SCRIPT],
    {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("the local helper that shortens the delay refuses everything but a local development database", () => {
  it("refuses a database that is not on this machine, before connecting", () => {
    for (const host of ["db.example.com", "10.0.0.5", "203.0.113.7", "db.internal.example"]) {
      const r = run({
        DATABASE_URL: `postgres://postgres:secret@${host}:5432/postgres`,
        DEV_DB_NAME: "delulu_dev",
      });
      expect(r.status, host).not.toBe(0);
      expect(r.stderr, host).toContain("local database only");
      expect(r.stderr).not.toContain("secret");
    }
  });

  it("refuses a server that is not on this machine, and production", () => {
    const local = {
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      DEV_DB_NAME: "delulu_dev",
    };
    const remote = run({ ...local, BASE_URL: "https://shop.example.com" });
    expect(remote.status).not.toBe(0);
    expect(remote.stderr).toContain("local server only");
    const prod = run({ ...local, NODE_ENV: "production" });
    expect(prod.status).not.toBe(0);
    expect(prod.stderr).toContain("development only");
  });

  it("refuses a database name that is not a plain lowercase identifier", () => {
    const r = run({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      DEV_DB_NAME: "delulu_dev; DROP TABLE x",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("plain lowercase identifier");
  });

  it("refuses a host smuggled in through the connection string's query or the environment", () => {
    const base = { DEV_DB_NAME: "delulu_dev" };
    const local = "postgres://postgres:secret@127.0.0.1:5432/postgres";
    const cases: [string, Record<string, string>][] = [
      ["?host=", { ...base, DATABASE_URL: `${local}?host=db.example.com` }],
      ["?hostaddr=", { ...base, DATABASE_URL: `${local}?hostaddr=203.0.113.7` }],
      ["?sslmode", { ...base, DATABASE_URL: `${local}?sslmode=disable` }],
      ["PGHOST", { ...base, DATABASE_URL: local, PGHOST: "db.example.com" }],
      ["PGHOSTADDR", { ...base, DATABASE_URL: local, PGHOSTADDR: "203.0.113.7" }],
    ];
    for (const [name, env] of cases) {
      const r = run(env);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toMatch(/local database only|no query string|PGHOST/);
      expect(r.stderr, name).not.toContain("secret");
    }
  });
});
