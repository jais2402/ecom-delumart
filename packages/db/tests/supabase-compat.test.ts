/**
 * The full migration set on a database laid out like a Supabase project, migrated by a
 * NON-superuser owner (as the project's `postgres` user is), then a smoke subset of the money tests.
 *
 * Emulated (what we believe a fresh Supabase project looks like; docs/deploy-runbook.md lists each
 * as "verify on first deploy" and `pnpm db:doctor` checks them on the real project):
 *   - an `auth` schema that already exists, owned by another role (the sign-in service's), with
 *     Supabase-shaped users / sessions / refresh_tokens / identities tables (more columns than the
 *     local stand-in, including users.phone_confirmed_at and sessions.not_after); the owner holds
 *     USAGE, SELECT and REFERENCES on the tables, USAGE and SELECT on the sequences, and NO insert,
 *     update or delete (the first test shows the doctor failing before the sequence grant);
 *   - pgcrypto already installed in an `extensions` schema the application roles cannot use;
 *   - the roles anon, authenticated and service_role, with Supabase's default privileges that grant
 *     them everything the owner creates in `public` (so public.schema_migrations would be readable);
 *   - an owner role with LOGIN and CREATEROLE but not SUPERUSER and not BYPASSRLS, which owns the
 *     database, whose search_path is "$user", public, extensions, and which is a member of
 *     pg_signal_backend and pg_read_all_stats;
 *   - the application roles already existing (they are cluster-wide here) with the owner holding
 *     ADMIN OPTION on them, as the role that created them on a fresh project would.
 * Not emulated: Supabase's event triggers, supautils' extension hooks, the pooler, the Data API
 * itself, and the exact grant set on every auth table.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckoutSession, createPaymentAttempt } from "../src/checkout";
import { endSession, registerAppSession } from "../src/deployment";
import { runDoctor } from "../src/doctor";
import { listMigrations, migrate } from "../src/migrate";
import { recordPhoneVerified } from "../src/onboarding";
import { authPhoneHolder } from "../src/phone";
import { sessionActor } from "../src/session-actor";
import {
  authenticateCard,
  CLEAN,
  checkout,
  merchantCoupon,
  payFor,
  product,
  reconcile,
  STANDARD_DELIVERY,
  standard,
  wallet,
} from "./checkout-fixtures";
import { ADMIN_URL, provisionAccount, provisionInput, type TestUser, uuidv7 } from "./helpers";

const OWNER = "delulu_sb_owner_test";
const AUTH_ADMIN = "delulu_sb_auth_admin_test";
const OWNER_PASSWORD = randomBytes(18).toString("hex");
const APP_ROLES = ["migrator", "app_web", "app_pay", "app_jobs", "npc_worker", "research_ro"];

/** Supabase-shaped auth tables (a subset of the real column set, with the real names and types). */
const AUTH_DDL = `
CREATE TABLE auth.users (
  instance_id uuid, id uuid PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), recovery_token varchar(255), last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  phone text UNIQUE DEFAULT NULL, phone_confirmed_at timestamptz, phone_change text DEFAULT '',
  email_change_confirm_status smallint DEFAULT 0, banned_until timestamptz,
  reauthentication_token varchar(255) DEFAULT '', is_sso_user boolean NOT NULL DEFAULT false,
  deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz, updated_at timestamptz, factor_id uuid, aal text, not_after timestamptz,
  refreshed_at timestamp, user_agent text, ip inet, tag text
);
CREATE TABLE auth.refresh_tokens (
  instance_id uuid, id bigserial PRIMARY KEY, token varchar(255) UNIQUE, user_id varchar(255),
  revoked boolean, created_at timestamptz, updated_at timestamptz, parent varchar(255),
  session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
);
CREATE TABLE auth.identities (
  provider_id text NOT NULL, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data jsonb NOT NULL, provider text NOT NULL, last_sign_in_at timestamptz,
  created_at timestamptz, updated_at timestamptz, email text, id uuid PRIMARY KEY
);`;

describe("Supabase-shaped database: the migrations as a non-superuser owner, then the money smoke", () => {
  const name = `delulu_test_${randomBytes(6).toString("hex")}`;
  let url: URL;
  /** The project's owner (non-superuser): migrations and fixtures. */
  let owner: pg.Pool;
  /** Stands in for the sign-in service (writes auth.*) and for the app logins (SET ROLE app_*). */
  let platform: pg.Pool;
  let createdServiceRole = false;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>, database = "postgres"): Promise<T> {
    const u = new URL(ADMIN_URL);
    u.pathname = `/${database}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await admin(async (c) => {
      for (const role of [OWNER, AUTH_ADMIN]) {
        await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
      await c.query(
        `CREATE ROLE ${OWNER} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD ${c.escapeLiteral(OWNER_PASSWORD)}`,
      );
      await c.query(`CREATE ROLE ${AUTH_ADMIN} NOLOGIN`);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
        if (!exists) {
          await c.query(`CREATE ROLE ${role} NOLOGIN`);
          if (role === "service_role") createdServiceRole = true;
        }
      }
      for (const role of APP_ROLES) {
        const exists = (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
        if (!exists) await c.query(`CREATE ROLE ${role} NOLOGIN`);
        await c.query(`GRANT ${role} TO ${OWNER} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      }
      await c.query(`GRANT pg_signal_backend, pg_read_all_stats TO ${OWNER}`);
      await c.query(`CREATE DATABASE ${name} OWNER ${OWNER}`);
    });
    await admin(async (c) => {
      await c.query(`CREATE SCHEMA auth AUTHORIZATION ${AUTH_ADMIN}`);
      await c.query(`SET ROLE ${AUTH_ADMIN}`);
      await c.query(AUTH_DDL);
      await c.query("RESET ROLE");
      await c.query(`GRANT USAGE ON SCHEMA auth TO ${OWNER}`);
      await c.query(`GRANT SELECT, REFERENCES ON ALL TABLES IN SCHEMA auth TO ${OWNER}`);
      await c.query("CREATE SCHEMA extensions");
      await c.query("CREATE EXTENSION pgcrypto WITH SCHEMA extensions");
      await c.query(`GRANT USAGE ON SCHEMA extensions TO ${OWNER}, anon, authenticated, service_role`);
      await c.query("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role");
      for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await c.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT ALL ON ${kind} TO anon, authenticated, service_role`,
        );
      }
      await c.query(`ALTER ROLE ${OWNER} IN DATABASE ${name} SET search_path = "$user", public, extensions`);
    }, name);

    url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const ownerUrl = new URL(url);
    ownerUrl.username = OWNER;
    ownerUrl.password = OWNER_PASSWORD;
    owner = new pg.Pool({ connectionString: ownerUrl.toString(), max: 4 });
    platform = new pg.Pool({ connectionString: url.toString(), max: 8 });
  });

  afterAll(async () => {
    await owner?.end();
    await platform?.end();
    await admin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const role of APP_ROLES) await c.query(`REVOKE ${role} FROM ${OWNER}`).catch(() => undefined);
      await c.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => undefined);
      await c.query(`DROP ROLE IF EXISTS ${AUTH_ADMIN}`).catch(() => undefined);
      if (createdServiceRole) await c.query("DROP ROLE IF EXISTS service_role").catch(() => undefined);
    });
  });

  /** A user and live session, written by the sign-in service (not the owner). */
  async function signUp(): Promise<{ userId: string; sessionId: string }> {
    const userId = uuidv7();
    const sessionId = uuidv7();
    await platform.query(
      "INSERT INTO auth.users (id, aud, role) VALUES ($1, 'authenticated', 'authenticated')",
      [userId],
    );
    await platform.query("INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())", [
      sessionId,
      userId,
    ]);
    // the web server accepts it after verifying the token (0074)
    await platform.query("SELECT core.register_app_session($1, $2)", [sessionId, userId]);
    return { userId, sessionId };
  }

  /** A provisioned player: the phone confirmed by the sign-in service, then onboarding as app_pay. */
  async function player(): Promise<TestUser> {
    const { userId, sessionId } = await signUp();
    await platform.query("UPDATE auth.users SET phone_confirmed_at = now() WHERE id = $1", [userId]);
    return provisionAccount(platform, provisionInput({ userId, authSessionId: sessionId }));
  }

  it("the doctor's pre-flight names an auth object the owner holds no privilege on (the REVOKEs of 0001 / 0047 would fail)", async () => {
    const c = await owner.connect();
    try {
      const versions = (await listMigrations()).map((m) => m.version);
      const checks = await runDoctor(c, { repositoryVersions: versions });
      const revoke = checks.find((k) => k.id === "auth.revoke_possible");
      expect(revoke?.status).toBe("FAIL");
      expect(revoke?.detail).toContain("refresh_tokens_id_seq");
    } finally {
      c.release();
    }
    // what we expect of a real project: the owner holds privileges on the auth sequences too
    await platform.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO ${OWNER}`);
  });

  it("the doctor's pre-flight passes the checks that matter before migrating", async () => {
    const c = await owner.connect();
    try {
      const versions = (await listMigrations()).map((m) => m.version);
      const checks = await runDoctor(c, { repositoryVersions: versions });
      const byId = new Map(checks.map((k) => [k.id, k]));
      expect(checks.filter((k) => k.status === "FAIL")).toEqual([]);
      expect(byId.get("auth.users.columns")?.status).toBe("PASS");
      expect(byId.get("auth.sessions.columns")?.status).toBe("PASS");
      expect(byId.get("auth.sessions.delete")?.status).toBe("WARN");
      expect(byId.get("extension.pgcrypto")?.detail).toMatch(/extensions/);
      expect(byId.get("migrations.pending")?.status).toBe("INFO");
      // nothing secret in the report
      expect(JSON.stringify(checks)).not.toContain(OWNER_PASSWORD);
    } finally {
      c.release();
    }
  });

  it("every migration applies as the non-superuser owner, and the API roles end up with nothing", async () => {
    await owner.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions");
    const result = await migrate(owner);
    expect(result.applied.length).toBe((await listMigrations()).length);
    await owner.query("SELECT ops.revoke_platform_api_roles()");
    const { rows } = await platform.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('core', 'ledger', 'private', 'audit', 'analytics', 'ops')
          AND pg_get_userbyid(c.relowner) <> $1`,
      [OWNER],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("the doctor's post-flight: no FAIL; RLS on everywhere; API roles hold nothing (even with Supabase's default grants)", async () => {
    const c = await owner.connect();
    try {
      const checks = await runDoctor(c, {
        repositoryVersions: (await listMigrations()).map((m) => m.version),
      });
      const byId = new Map(checks.map((k) => [k.id, k]));
      expect(checks.filter((k) => k.status === "FAIL")).toEqual([]);
      for (const id of [
        "rls.enabled",
        "api.anon",
        "api.authenticated",
        "api.service_role",
        "migrations.pending",
        "phone.sms_check",
      ]) {
        expect(byId.get(id)?.status, id).toBe("PASS");
      }
      // what a non-superuser owner cannot fix, reported as WARN rather than hidden
      expect(byId.get("database.advisory_locks")?.status).toBe("WARN");
    } finally {
      c.release();
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows } = await platform.query<{ ok: boolean }>(
        "SELECT has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS ok",
        [role],
      );
      expect(rows[0]?.ok, role).toBe(false);
    }
  });

  it("core.actor_id() reads the Supabase-shaped tables: live, revoked by deletion, banned, deleted, too old", async () => {
    const a = await signUp();
    expect((await sessionActor(platform, { authSessionId: a.sessionId }))?.userId).toBe(a.userId);
    await platform.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [
      a.userId,
    ]);
    expect(await sessionActor(platform, { authSessionId: a.sessionId })).toBeNull();
    const b = await signUp();
    await platform.query("UPDATE auth.users SET deleted_at = now() WHERE id = $1", [b.userId]);
    expect(await sessionActor(platform, { authSessionId: b.sessionId })).toBeNull();
    const c = await signUp();
    await platform.query("DELETE FROM auth.sessions WHERE id = $1", [c.sessionId]);
    expect(await sessionActor(platform, { authSessionId: c.sessionId })).toBeNull();
    const d = await signUp();
    await platform.query("UPDATE auth.sessions SET created_at = now() - interval '8 days' WHERE id = $1", [
      d.sessionId,
    ]);
    expect(await sessionActor(platform, { authSessionId: d.sessionId })).toBeNull();
  });

  it("ninth review, minor 4: a session minted at the platform but never accepted by the web server, or an anonymous user's, signs nobody in", async () => {
    const userId = uuidv7();
    const sessionId = uuidv7();
    await platform.query(
      "INSERT INTO auth.users (id, aud, role) VALUES ($1, 'authenticated', 'authenticated')",
      [userId],
    );
    await platform.query("INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())", [
      sessionId,
      userId,
    ]);
    expect(await sessionActor(platform, { authSessionId: sessionId })).toBeNull();
    const anon = uuidv7();
    const anonSession = uuidv7();
    await platform.query(
      "INSERT INTO auth.users (id, aud, role, is_anonymous) VALUES ($1, 'authenticated', 'authenticated', true)",
      [anon],
    );
    await platform.query("INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1, $2, now())", [
      anonSession,
      anon,
    ]);
    expect(await registerAppSession(platform, { authSessionId: anonSession, userId: anon })).toBe(false);
    expect(await sessionActor(platform, { authSessionId: anonSession })).toBeNull();
    expect(await registerAppSession(platform, { authSessionId: sessionId, userId })).toBe(true);
    expect((await sessionActor(platform, { authSessionId: sessionId }))?.userId).toBe(userId);
  });

  it("ninth review, major 1: core.auth_phone_holder names only an UNCONFIRMED holder older than the code lifetime, never a confirmed one or the caller", async () => {
    const victim = await signUp();
    const fp = randomBytes(32);
    const holderOf = (phone: string) =>
      authPhoneHolder(platform, {
        authSessionId: victim.sessionId,
        phoneDigits: phone,
        phoneFingerprint: fp,
      });
    const squatter = await signUp();
    await platform.query("UPDATE auth.users SET phone = '919800000001', created_at = now() WHERE id = $1", [
      squatter.userId,
    ]);
    expect(await holderOf("919800000001")).toBeNull(); // young
    await platform.query("UPDATE auth.users SET created_at = now() - interval '11 minutes' WHERE id = $1", [
      squatter.userId,
    ]);
    expect(await holderOf("919800000001")).toBe(squatter.userId);
    // a hold the server recorded for that number counts from when it set it
    await owner.query("INSERT INTO core.phone_hold (user_id, phone_fp, set_at) VALUES ($1, $2, now())", [
      squatter.userId,
      fp,
    ]);
    expect(await holderOf("919800000001")).toBeNull();
    const confirmed = await signUp();
    await platform.query(
      "UPDATE auth.users SET phone = '919800000002', phone_confirmed_at = now(), created_at = now() - interval '1 day' WHERE id = $1",
      [confirmed.userId],
    );
    expect(await holderOf("919800000002")).toBeNull();
    await platform.query(
      "UPDATE auth.users SET phone = '919800000003', created_at = now() - interval '1 day' WHERE id = $1",
      [victim.userId],
    );
    expect(await holderOf("919800000003")).toBeNull(); // the caller itself
  });

  it("sign-out without DELETE on auth.sessions: the session ends here, the platform's row stays", async () => {
    const a = await signUp();
    await endSession(platform, { authSessionId: a.sessionId });
    expect(await sessionActor(platform, { authSessionId: a.sessionId })).toBeNull();
    const { rowCount } = await platform.query("SELECT 1 FROM auth.sessions WHERE id = $1", [a.sessionId]);
    expect(rowCount).toBe(1);
  });

  it("'sms' mode requires auth.users.phone_confirmed_at; 'unverified' mode (owner-only) does not, and marks the profile", async () => {
    const a = await signUp();
    const record = (s: string) =>
      recordPhoneVerified(platform, {
        authSessionId: s,
        phoneFingerprint: randomBytes(32),
        emailFingerprint: randomBytes(32),
      });
    await expect(record(a.sessionId)).rejects.toMatchObject({ code: "PHONE_REQUIRED" });
    await platform.query("UPDATE auth.users SET phone_confirmed_at = now() WHERE id = $1", [a.userId]);
    await expect(record(a.sessionId)).resolves.toMatchObject({ phoneVerified: true });

    await owner.query(
      "UPDATE core.deployment_setting SET value = 'unverified' WHERE key = 'identity.phone_verification'",
    );
    try {
      const b = await signUp();
      // ninth review, major 1: recorded, but not reported as verified
      await expect(record(b.sessionId)).resolves.toMatchObject({ phoneRecorded: true, phoneVerified: false });
      const { rows } = await owner.query<{ v: boolean }>(
        "SELECT phone_verified AS v FROM core.user_profile WHERE id = $1",
        [b.userId],
      );
      expect(rows[0]?.v).toBe(false);
    } finally {
      await owner.query(
        "UPDATE core.deployment_setting SET value = 'sms' WHERE key = 'identity.phone_verification'",
      );
    }
  });

  it("money smoke: provisioning, a PIN (pgcrypto in `extensions`), a seed purchase and a coupon purchase reconcile", async () => {
    const buyer = await player();
    expect(await wallet(owner, buyer.ledgerAccountId)).toBe(100_000_000_000n);

    const seed = await product(owner, { mode: "UNLIMITED_SEED", pricePaise: 50_000n });
    const co = await checkout(platform, buyer, [seed], standard("SEED"));
    await payFor(platform, buyer, co);
    expect(await wallet(owner, buyer.ledgerAccountId)).toBe(100_000_000_000n - 50_000n - STANDARD_DELIVERY);

    // a private merchant coupon's code comes from extensions.gen_random_bytes; the card PIN from crypt()
    const shopOwner = await player();
    const shop = { owner: shopOwner, companyId: uuidv7(), warehouseId: uuidv7() };
    await owner.query("INSERT INTO core.company (id, owner_user_id, name) VALUES ($1, $2, 'Compat Shop')", [
      shop.companyId,
      shopOwner.userId,
    ]);
    await owner.query(
      "INSERT INTO core.warehouse (id, company_id, kind, capacity, used) VALUES ($1, $2, 'STARTER', 100, 0)",
      [shop.warehouseId, shop.companyId],
    );
    const stocked = await product(owner, {
      seller: shop,
      mode: "STANDARD_STOCKED",
      pricePaise: 1_000_000n,
      units: 2,
    });
    const coupon = await merchantCoupon(owner, shop, { percent: 10 });
    expect(coupon.code).toMatch(/^[A-Z2-9]{16}$/);
    const session = await createCheckoutSession(platform, {
      authSessionId: buyer.authSessionId,
      lines: [{ productId: stocked.id }],
      speedBySeller: standard(shop),
      couponCode: coupon.code,
      idempotencyKey: `k-${uuidv7()}`,
    });
    const attempt = await createPaymentAttempt(platform, {
      authSessionId: buyer.authSessionId,
      sessionId: session.sessionId,
      method: "CARD",
      cardId: buyer.cardId,
    });
    await authenticateCard(platform, buyer, attempt.attemptId);
    await payFor(platform, buyer, {
      sessionId: session.sessionId,
      attemptId: attempt.attemptId,
      totalPaise: session.totalPaise,
      sellers: session.sellers,
    });

    expect(await reconcile(owner)).toEqual(CLEAN);
  });
});
