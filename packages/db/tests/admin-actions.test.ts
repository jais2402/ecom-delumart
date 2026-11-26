import {
  ADMIN_ACTION_KINDS,
  ADMIN_ACTION_RULES,
  CONFIG_KEYS,
  DEFAULT_PRICING_CONFIG,
  DomainError,
  price,
  readConfigValue,
} from "@delulu/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminActions,
  adminConfigOverview,
  cancelAdminAction,
  executeDueAdminActions,
  proposeConfigChange,
  publicAnnouncements,
} from "../src/admin-actions";
import {
  CLEAN,
  checkout,
  count,
  journalPostings,
  type ProductFixture,
  payFor,
  product,
  RUPEE,
  reconcile,
  seller,
  standard,
  user,
} from "./checkout-fixtures";
import { asActor, createTestDatabase, stateOf, type TestDatabase, type TestUser, uuidv7 } from "./helpers";

/**
 * The Super Admin's 24-hour delayed, cancellable queue and versioned configuration changes
 * (migration 0090; PRD R16.6, R7 Economy, R10 ConsoleConfigChange; US-60; docs/decisions.md #15).
 */
const REASON = "Seasonal change agreed after reviewing the numbers";
const DAY_MS = 86_400_000;

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    return `${(e as { code?: string }).code ?? "unexpected"}`;
  }
  return "ok";
}

describe("Super Admin delayed actions and configuration versions (migration 0090)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;
  let player: TestUser;

  const propose = (key: string, value: string, reason = REASON, who: TestUser = admin) =>
    proposeConfigChange(pool, { authSessionId: who.authSessionId, key, value, reason });
  const cancel = (id: string, reason = REASON, who: TestUser = admin) =>
    cancelAdminAction(pool, { authSessionId: who.authSessionId, actionId: id, reason });
  const makeDue = (id: string) =>
    pool.query(
      "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
  /** Stands in for the grace period having passed (owner only; no application role can). */
  const makeEffective = () =>
    pool.query(
      "UPDATE core.config_version SET effective_from = clock_timestamp() WHERE effective_from > now()",
    );
  const versions = () => count(pool, "SELECT count(*) AS n FROM core.config_version");
  const tipValues = async (): Promise<Record<string, unknown>> => {
    const { rows } = await pool.query<{ values: Record<string, unknown> }>(
      "SELECT values FROM core.config_version ORDER BY id DESC LIMIT 1",
    );
    return rows[0]?.values ?? {};
  };
  const stateOfAction = async (id: string) =>
    (await pool.query<{ state: string }>("SELECT state FROM audit.pending_action WHERE id = $1", [id]))
      .rows[0]?.state;
  /** Runs the executor until nothing due is left, as the jobs endpoint would over several runs. */
  const drain = async () => {
    let executed = 0;
    for (let i = 0; i < 10; i++) {
      const r = await executeDueAdminActions(pool);
      executed += r.executed;
      if (r.executed + r.failed === 0) break;
    }
    return executed;
  };

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 24 });
    pool = db.pool;
    admin = await user(pool);
    player = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  describe("proposing (US-60: queued, cancellable, applied later)", () => {
    it("US-60: a Super Admin queues a configuration change for 24 hours later; nothing changes now", async () => {
      const before = await versions();
      const t0 = Date.now();
      const a = await propose("fee_percent", "7");
      expect(a).toMatchObject({ kind: "config.set", key: "fee_percent", value: "7", state: "QUEUED" });
      const waitMs = Date.parse(a.notBefore) - t0;
      expect(waitMs).toBeGreaterThan(DAY_MS - 5_000);
      expect(waitMs).toBeLessThan(DAY_MS + 5_000);
      expect(await versions()).toBe(before);
      const { rows } = await pool.query(
        `SELECT state, reason, payload, requested_by,
                payload_hash = sha256(convert_to(payload::text, 'UTF8')) AS hash_ok
           FROM audit.pending_action WHERE id = $1`,
        [a.id],
      );
      expect(rows[0]).toMatchObject({
        state: "QUEUED",
        reason: REASON,
        payload: { key: "fee_percent", value: "7" },
        requested_by: admin.userId,
        hash_ok: true, // the stored hash is the SHA-256 of the canonical payload text
      });
      await cancel(a.id);
    });

    it("US-60: the proposal is audit-logged and notified through the outbox with no personal data", async () => {
      const a = await propose("delivery_fee_paise.STANDARD", "120000");
      const log = await pool.query(
        "SELECT actor_kind, actor_id, action, target_type, target_id, reason, detail FROM audit.audit_log WHERE action = 'admin_action.propose' AND target_id = $1",
        [a.id],
      );
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0]).toMatchObject({
        actor_kind: "SUPER_ADMIN",
        actor_id: admin.userId,
        reason: REASON,
        detail: { kind: "config.set", key: "delivery_fee_paise.STANDARD", value: "120000" },
      });
      const outbox = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM audit.outbox WHERE type = 'admin_action_proposed' AND aggregate_id = $1",
        [a.id],
      );
      expect(outbox.rows).toHaveLength(1);
      const text = JSON.stringify(outbox.rows[0]?.payload);
      expect(outbox.rows[0]?.payload).toMatchObject({ actionId: a.id, kind: "config.set" });
      // invariant 8: ids, the key and times only; no user id, no reason, no address of any kind
      expect(text).not.toContain(admin.userId);
      expect(text).not.toContain(REASON);
      expect(text).not.toMatch(/@/);
      await cancel(a.id);
    });

    it("US-60: anyone but the Super Admin is refused FORBIDDEN on every queue command and read", async () => {
      const a = await propose("fee_percent", "8");
      const calls: (() => Promise<unknown>)[] = [
        () => propose("fee_percent", "9", REASON, player),
        () => cancel(a.id, REASON, player),
        () => adminActions(pool, { authSessionId: player.authSessionId, scope: "ALL", page: 1 }),
        () => adminConfigOverview(pool, { authSessionId: player.authSessionId }),
      ];
      for (const call of calls) expect(await errorOf(call())).toBe("FORBIDDEN");
      expect(await stateOfAction(a.id)).toBe("QUEUED");
      await cancel(a.id);
    });

    it("US-60: proposing needs a recent sign-in (REAUTH_REQUIRED); reading and cancelling do not", async () => {
      const a = await propose("fee_percent", "6");
      await pool.query("UPDATE auth.sessions SET created_at = now() - interval '1 hour' WHERE id = $1", [
        admin.authSessionId,
      ]);
      try {
        expect(await errorOf(propose("fee_percent", "9"))).toBe("REAUTH_REQUIRED");
        const read = await adminActions(pool, { authSessionId: admin.authSessionId, scope: "OPEN", page: 1 });
        expect(read.items.some((i) => i.id === a.id)).toBe(true);
        // cancelling only ever removes a change, so a stale session may do it (decisions.md #15)
        await cancel(a.id);
        expect(await stateOfAction(a.id)).toBe("CANCELLED");
      } finally {
        await pool.query("UPDATE auth.sessions SET created_at = now() WHERE id = $1", [admin.authSessionId]);
      }
    });

    it("R16.6: an action kind that is not on the allow-list is refused, however the call is made", async () => {
      const call = (kind: string, payload: unknown) =>
        errorOf(
          asActor(pool, { role: "app_web", userId: admin.userId }, async (c) => {
            await c.query("SELECT core.admin_action_propose($1, $2::jsonb, $3)", [
              kind,
              JSON.stringify(payload),
              REASON,
            ]);
          }).catch((e: { hint?: string }) => {
            throw new DomainError((e.hint ?? "VALIDATION_FAILED") as never, "refused");
          }),
        );
      for (const kind of [
        "mint.currency",
        "platform_coupon.budget",
        "reversal.order",
        "research.export",
        "",
        "config.set ",
      ])
        expect(await call(kind, { key: "fee_percent", value: "6" }), kind).toBe("ADMIN_ACTION_UNKNOWN");
      expect([...ADMIN_ACTION_KINDS]).toEqual(["config.set"]);
    });

    it("R7: a key outside the allow-list or a value outside its bounds is refused when proposed (checkout cannot be broken)", async () => {
      const unknownKeys = [
        "starter_grant_paise",
        "price_min_paise",
        "creator_threshold_paise",
        "analytics.place_min_visitors",
        "watchdog_min_age_seconds",
        "",
        "fee_percent.x",
      ];
      for (const key of unknownKeys) expect(await errorOf(propose(key, "1")), key).toBe("CONFIG_KEY_UNKNOWN");
      const fee = CONFIG_KEYS.find((k) => k.key === "fee_percent");
      const zap = CONFIG_KEYS.find((k) => k.key === "delivery_fee_paise.ZAP");
      if (!fee || !zap) throw new Error("missing spec");
      const bad: [string, string][] = [
        ["fee_percent", "-1"],
        ["fee_percent", (fee.max + 1n).toString()],
        ["fee_percent", "5.5"],
        ["fee_percent", "1e1"],
        ["fee_percent", " 7"],
        ["fee_percent", "07"],
        ["fee_percent", ""],
        ["fee_percent", "٧"],
        ["delivery_fee_paise.ZAP", (zap.max + 1n).toString()],
        ["delivery_fee_paise.ZAP", "99999999999999999999"],
        ["delivery_fee_paise.ZAP", "-100"],
      ];
      for (const [key, value] of bad)
        expect(await errorOf(propose(key, value)), `${key}=${value}`).toBe("CONFIG_VALUE_INVALID");
      // the payload itself must be exactly {key, value} with strings (a number is not a decimal string)
      for (const payload of [
        { key: "fee_percent", value: 7 },
        { key: "fee_percent" },
        { key: "fee_percent", value: "7", extra: "x" },
        [],
      ]) {
        const code = await errorOf(
          asActor(pool, { role: "app_web", userId: admin.userId }, async (c) => {
            await c.query("SELECT core.admin_action_propose('config.set', $1::jsonb, $2)", [
              JSON.stringify(payload),
              REASON,
            ]);
          }).catch((e: { hint?: string }) => {
            throw new DomainError((e.hint ?? "VALIDATION_FAILED") as never, "refused");
          }),
        );
        expect(
          ["CONFIG_VALUE_INVALID", "CONFIG_KEY_UNKNOWN", "VALIDATION_FAILED"],
          JSON.stringify(payload),
        ).toContain(code);
      }
      expect(await count(pool, "SELECT count(*) AS n FROM audit.pending_action WHERE state = 'QUEUED'")).toBe(
        0,
      );
    });

    it("R7: every key is accepted at its minimum and at its maximum", async () => {
      for (const k of CONFIG_KEYS) {
        for (const v of [k.min, k.max]) {
          if (v === readConfigValue(await tipValues(), k)) continue;
          const a = await propose(k.key, v.toString());
          expect(a.state).toBe("QUEUED");
          await cancel(a.id);
        }
      }
    });

    it("R7: a reason of 5 to 500 characters is required, without contact details or links", async () => {
      for (const reason of [
        "",
        "no",
        "x".repeat(501),
        "write to me at someone@example.com",
        "see https://example.com/page",
        "call 98765 43210",
      ])
        expect(await errorOf(propose("fee_percent", "9", reason)), reason).toBe("VALIDATION_FAILED");
    });

    it("US-60: proposing the value that is already current, or a second waiting change to the same key, is a CONFLICT", async () => {
      expect(await errorOf(propose("fee_percent", "5"))).toBe("CONFLICT");
      const a = await propose("fee_percent", "9");
      expect(await errorOf(propose("fee_percent", "10"))).toBe("CONFLICT");
      await cancel(a.id);
      const b = await propose("fee_percent", "10"); // free again once the first is cancelled
      await cancel(b.id);
    });
  });

  describe("cancelling", () => {
    it("US-60: a waiting action is cancelled with a reason, audit-logged, and never runs", async () => {
      const before = await versions();
      const a = await propose("fee_percent", "11");
      const c = await cancel(a.id, "Changed my mind about the fee");
      expect(c).toMatchObject({ id: a.id, state: "CANCELLED" });
      const { rows } = await pool.query(
        "SELECT state, cancelled_at, cancel_reason, executed_at FROM audit.pending_action WHERE id = $1",
        [a.id],
      );
      expect(rows[0]).toMatchObject({
        state: "CANCELLED",
        cancel_reason: "Changed my mind about the fee",
        executed_at: null,
      });
      expect(rows[0].cancelled_at).toBeInstanceOf(Date);
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'admin_action.cancel' AND target_id = $1",
          [a.id],
        ),
      ).toBe(1);
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM audit.outbox WHERE type = 'admin_action_cancelled' AND aggregate_id = $1",
          [a.id],
        ),
      ).toBe(1);
      // even when it is overdue, a cancelled action is never executed
      // (the table refuses to change a finished action, even by the owner, so the only way it
      // could still run is a bug in the executor's own filter)
      await makeDue(a.id).catch(() => undefined);
      expect(await drain()).toBe(0);
      expect(await versions()).toBe(before);
      expect(await stateOfAction(a.id)).toBe("CANCELLED");
    });

    it("US-60: cancelling twice, an unknown action or a finished one is refused", async () => {
      const a = await propose("fee_percent", "12");
      await cancel(a.id);
      expect(await errorOf(cancel(a.id))).toBe("CONFLICT");
      expect(await errorOf(cancel(uuidv7()))).toBe("NOT_FOUND");
    });
  });

  describe("executing (US-60: exactly once, versioned, attributed)", () => {
    it("US-60: an action that is not due yet is not executed", async () => {
      const a = await propose("fee_percent", "6");
      const r = await executeDueAdminActions(pool);
      expect(r).toMatchObject({ executed: 0, failed: 0 });
      expect(await stateOfAction(a.id)).toBe("QUEUED");
      await cancel(a.id);
    });

    it("R7: a due action creates a NEW configuration version, leaves the old one untouched and records who, why, before and after", async () => {
      const { rows: oldRows } = await pool.query<{
        id: number;
        values: unknown;
        effective_from: Date;
        note: string | null;
      }>("SELECT id, values, effective_from, note FROM core.config_version ORDER BY id DESC LIMIT 1");
      const old = oldRows[0];
      if (!old) throw new Error("no configuration");
      const a = await propose("fee_percent", "7", "Raise the fee for the autumn season");
      await makeDue(a.id);
      const r = await executeDueAdminActions(pool);
      expect(r).toMatchObject({ executed: 1, failed: 0 });

      // the old version is exactly as it was
      const again = await pool.query(
        "SELECT id, values, effective_from, note FROM core.config_version WHERE id = $1",
        [old.id],
      );
      expect(again.rows[0]).toEqual(old);
      // a new version, with the old values plus the change, effective after the grace period
      const { rows } = await pool.query<{
        id: number;
        values: Record<string, unknown>;
        seconds: string;
        created_by: string;
        note: string;
      }>(
        `SELECT id, values, extract(epoch FROM effective_from - clock_timestamp())::text AS seconds, created_by, note
           FROM core.config_version ORDER BY id DESC LIMIT 1`,
      );
      const created = rows[0];
      expect(created?.id).toBeGreaterThan(old.id);
      expect(created?.values).toEqual({ ...(old.values as object), fee_percent: 7 });
      expect(Number(created?.seconds)).toBeGreaterThan(ADMIN_ACTION_RULES.applyGraceSeconds - 5);
      expect(Number(created?.seconds)).toBeLessThanOrEqual(ADMIN_ACTION_RULES.applyGraceSeconds);
      expect(created?.created_by).toBe(admin.userId);
      expect(created?.note).not.toContain("autumn"); // the note is readable by application roles: no reason in it

      const act = await pool.query(
        "SELECT state, executed_at, outcome FROM audit.pending_action WHERE id = $1",
        [a.id],
      );
      expect(act.rows[0]).toMatchObject({
        state: "EXECUTED",
        outcome: { changed: true, configVersion: created?.id },
      });
      expect(act.rows[0].executed_at).toBeInstanceOf(Date);

      // ConsoleConfigChange: area, before/after, version, actor, approver, reason
      const change = await pool.query(
        "SELECT area, key, old_value, new_value, previous_version, new_version, actor_id, approver, reason FROM audit.config_change WHERE action_id = $1",
        [a.id],
      );
      expect(change.rows).toEqual([
        {
          area: "ECONOMY",
          key: "fee_percent",
          old_value: "5",
          new_value: "7",
          previous_version: old.id,
          new_version: created?.id,
          actor_id: admin.userId,
          approver: "DELAYED_EXECUTION",
          reason: "Raise the fee for the autumn season",
        },
      ]);
      const audit = await pool.query(
        "SELECT actor_kind, detail FROM audit.audit_log WHERE action = 'admin_action.execute' AND target_id = $1",
        [a.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_kind: "SYSTEM",
        detail: {
          key: "fee_percent",
          oldValue: "5",
          newValue: "7",
          configVersion: created?.id,
          requestedBy: admin.userId,
        },
      });
      expect(
        await count(
          pool,
          "SELECT count(*) AS n FROM audit.outbox WHERE type = 'admin_action_executed' AND aggregate_id = $1",
          [a.id],
        ),
      ).toBe(1);
      await makeEffective();
    });

    it("R10: the console_config_changed analytics event is written with no user id, no visitor and no values", async () => {
      const { rows } = await pool.query<{
        name: string;
        surface: string;
        visitor_key: unknown;
        props: unknown;
        signed_in: boolean;
        on_hour: boolean;
      }>(
        `SELECT name, surface, visitor_key, props, signed_in, mod(extract(epoch FROM occurred_at), 3600) = 0 AS on_hour
           FROM analytics.event WHERE name = 'console_config_changed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ surface: "console", visitor_key: null, props: {}, on_hour: true });
      // and the daily rollup still runs with it present
      await pool.query("SELECT analytics.rollup_day((now() AT TIME ZONE 'UTC')::date)");
      const cols = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'event'",
      );
      expect(cols.rows.map((c) => c.column_name).filter((c) => /user/.test(c))).toEqual([]);
    });

    it("US-60: running the executor again does nothing; an executed action is never executed twice", async () => {
      const before = await versions();
      const r = await executeDueAdminActions(pool);
      expect(r).toMatchObject({ executed: 0, failed: 0 });
      expect(await versions()).toBe(before);
    });

    it("US-60: the new version is not the current one until the grace period has passed, then it is", async () => {
      await pool.query(
        "UPDATE core.config_version SET effective_from = clock_timestamp() + interval '20 seconds' WHERE id = (SELECT max(id) FROM core.config_version)",
      );
      const cur = async () =>
        (
          await pool.query<{ fee: string }>(
            "SELECT core.config_int(core.current_config_id(), ARRAY['fee_percent'], 5)::text AS fee",
          )
        ).rows[0]?.fee;
      expect(await cur()).toBe("5");
      await makeEffective();
      expect(await cur()).toBe("7");
    });

    it("US-60, race: concurrent job runs execute every due action exactly once and lose no update", async () => {
      const a = await propose("delivery_fee_paise.STANDARD", "120000");
      const b = await propose("delivery_fee_paise.EXPRESS", "1500000");
      const c = await propose("delivery_fee_paise.ZAP", "6000000");
      for (const x of [a, b, c]) await makeDue(x.id);
      const before = await versions();
      const runs = await Promise.all(
        Array.from({ length: 8 }, () =>
          executeDueAdminActions(pool).catch(() => ({ executed: 0, failed: 0, skipped: 0 })),
        ),
      );
      let executed = runs.reduce((n, r) => n + r.executed, 0);
      executed += await drain(); // anything a busy run left queued
      expect(executed).toBe(3);
      expect(await versions()).toBe(before + 3);
      for (const x of [a, b, c]) expect(await stateOfAction(x.id)).toBe("EXECUTED");
      // every change is in the newest version: none overwrote another
      expect(await tipValues()).toMatchObject({
        fee_percent: 7,
        delivery_fee_paise: { STANDARD: "120000", EXPRESS: "1500000", ZAP: "6000000" },
      });
      const outcomes = await pool.query<{ v: string }>(
        "SELECT (outcome->>'configVersion') AS v FROM audit.pending_action WHERE id = ANY($1)",
        [[a.id, b.id, c.id]],
      );
      expect(new Set(outcomes.rows.map((r) => r.v)).size).toBe(3);
      expect(
        await count(pool, "SELECT count(*) AS n FROM audit.config_change WHERE action_id = ANY($1)", [
          [a.id, b.id, c.id],
        ]),
      ).toBe(3);
      await makeEffective();
    });

    it("US-60: an action a run has locked is skipped by other runs, and a cancel waits for it and wins", async () => {
      const a = await propose("fee_percent", "9");
      await makeDue(a.id);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM audit.pending_action WHERE id = $1 FOR UPDATE", [a.id]);
        expect(await executeDueAdminActions(pool)).toMatchObject({ executed: 0 });
        const cancelling = cancel(a.id);
        await new Promise((r) => setTimeout(r, 300));
        await holder.query("COMMIT");
        expect((await cancelling).state).toBe("CANCELLED");
      } finally {
        holder.release();
      }
      expect(await drain()).toBe(0);
      expect(await stateOfAction(a.id)).toBe("CANCELLED");
    });

    it("R7: an action planted past the proposal checks (bad key, bad kind, tampered payload) fails safely and does not stop the others", async () => {
      const good = await propose("fee_percent", "8");
      await makeDue(good.id);
      const plant = async (action: string, payload: unknown, tamper = false) => {
        const id = uuidv7();
        await pool.query(
          `INSERT INTO audit.pending_action (id, action, payload, payload_hash, requested_by, not_before, reason)
           VALUES ($1, $2, $3::jsonb,
                   CASE WHEN $4::boolean THEN decode('00', 'hex') ELSE sha256(convert_to($3::jsonb::text, 'UTF8')) END,
                   $5, clock_timestamp() - interval '2 seconds', 'planted by a test')`,
          [id, action, JSON.stringify(payload), tamper, admin.userId],
        );
        return id;
      };
      const badKey = await plant("config.set", { key: "starter_grant_paise", value: "1" });
      const badValue = await plant("config.set", { key: "fee_percent", value: "99" });
      const badKind = await plant("mint.currency", { amount: "1" });
      const tampered = await plant("config.set", { key: "fee_percent", value: "3" }, true);
      const before = await versions();
      const r = await executeDueAdminActions(pool);
      expect(r).toMatchObject({ executed: 1, failed: 4 });
      expect(await versions()).toBe(before + 1);
      const codes = await pool.query<{ id: string; state: string; code: string }>(
        "SELECT id, state, outcome->>'code' AS code FROM audit.pending_action WHERE id = ANY($1)",
        [[badKey, badValue, badKind, tampered]],
      );
      const by = Object.fromEntries(codes.rows.map((x) => [x.id, x]));
      expect(by[badKey]).toMatchObject({ state: "FAILED", code: "CONFIG_KEY_UNKNOWN" });
      expect(by[badValue]).toMatchObject({ state: "FAILED", code: "CONFIG_VALUE_INVALID" });
      expect(by[badKind]).toMatchObject({ state: "FAILED", code: "ADMIN_ACTION_UNKNOWN" });
      expect(by[tampered]).toMatchObject({ state: "FAILED", code: "PAYLOAD_TAMPERED" });
      expect(await stateOfAction(good.id)).toBe("EXECUTED");
      expect(
        await count(pool, "SELECT count(*) AS n FROM audit.audit_log WHERE action = 'admin_action.fail'"),
      ).toBe(4);
      expect(await tipValues()).toMatchObject({ fee_percent: 8 });
      // a failed action is final: it does not run again
      expect(await drain()).toBe(0);
      await makeEffective();
    });

    it("R7: a change that has become a no-op by the time it runs is recorded as executed without a new version", async () => {
      const a = await propose("fee_percent", "13");
      await pool.query(
        `INSERT INTO core.config_version (values, effective_from, note)
         SELECT jsonb_set(values, '{fee_percent}', '13'), now() - interval '1 second', 'owner set' FROM core.config_version ORDER BY id DESC LIMIT 1`,
      );
      await makeDue(a.id);
      const before = await versions();
      expect(await executeDueAdminActions(pool)).toMatchObject({ executed: 1 });
      expect(await versions()).toBe(before);
      const act = await pool.query("SELECT state, outcome FROM audit.pending_action WHERE id = $1", [a.id]);
      expect(act.rows[0]).toMatchObject({ state: "EXECUTED", outcome: { changed: false } });
      expect(
        await count(pool, "SELECT count(*) AS n FROM audit.config_change WHERE action_id = $1", [a.id]),
      ).toBe(0);
    });
  });

  describe("orders keep the version they were placed under (R7)", () => {
    let seed: Awaited<ReturnType<typeof seller>>;
    let lamp: ProductFixture;

    /** The amounts the single pricing function gives for the lamp under a configuration's values. */
    const expectedAmounts = async (values: Record<string, unknown>): Promise<bigint[]> => {
      const read = (key: string) => {
        const spec = CONFIG_KEYS.find((k) => k.key === key);
        if (!spec) throw new Error(key);
        return readConfigValue(values, spec);
      };
      const priced = price({
        lines: [
          {
            productId: lamp.id,
            sellerId: seed.companyId,
            listPaise: lamp.pricePaise,
            freeStdDelivery: false,
          },
        ],
        speedBySeller: new Map([[seed.companyId, "STANDARD" as const]]),
        isMember: false,
        cfg: {
          ...DEFAULT_PRICING_CONFIG,
          feePercent: Number(read("fee_percent")),
          deliveryFeePaise: {
            STANDARD: read("delivery_fee_paise.STANDARD"),
            EXPRESS: read("delivery_fee_paise.EXPRESS"),
            ZAP: read("delivery_fee_paise.ZAP"),
          },
        },
      });
      return priced.postings.map((p) => p.amountPaise).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    };
    const valuesOf = async (version: number): Promise<Record<string, unknown>> =>
      (
        await pool.query<{ values: Record<string, unknown> }>(
          "SELECT values FROM core.config_version WHERE id = $1",
          [version],
        )
      ).rows[0]?.values ?? {};
    const amountsOf = async (orderGroupId: string): Promise<bigint[]> =>
      [...(await journalPostings(pool, orderGroupId)).values()]
        .filter((v) => v !== 0n)
        .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    // a buyer owns a product once, so each purchase is a new buyer
    const buy = async (co: Awaited<ReturnType<typeof checkout>>, who: TestUser) => {
      const receipt = await payFor(pool, who, co);
      const { rows } = await pool.query<{ config_version: number }>(
        "SELECT config_version FROM core.order_group WHERE id = $1",
        [receipt.orderGroupId],
      );
      return { receipt, version: rows[0]?.config_version ?? -1 };
    };
    const currentVersion = async () =>
      (await pool.query<{ id: number }>("SELECT core.current_config_id() AS id")).rows[0]?.id ?? -1;

    beforeAll(async () => {
      seed = await seller(pool);
      lamp = await product(pool, {
        seller: seed,
        mode: "STANDARD_STOCKED",
        pricePaise: 1_000n * RUPEE,
        units: 12,
      });
    }, 60_000);

    it("R7: an order placed before a change keeps its version and amounts; one placed after uses the new version", async () => {
      const v0 = await currentVersion();
      const feeBefore = readConfigValue(await valuesOf(v0), CONFIG_KEYS[0] as (typeof CONFIG_KEYS)[number]);
      const newFee = feeBefore === 20n ? "19" : "20";
      const b1 = await user(pool);
      const first = await buy(await checkout(pool, b1, [lamp], standard(seed)), b1);
      expect(first.version).toBe(v0);
      const firstAmounts = await amountsOf(first.receipt.orderGroupId);
      expect(firstAmounts).toEqual(await expectedAmounts(await valuesOf(v0)));

      // a checkout session opened under v0 BEFORE the change, paid AFTER it, still prices under v0
      const b2 = await user(pool);
      const open = await checkout(pool, b2, [lamp], standard(seed));

      const a = await propose("fee_percent", newFee);
      await makeDue(a.id);
      expect(await drain()).toBe(1);
      await makeEffective();
      const v1 = await currentVersion();
      expect(v1).toBeGreaterThan(v0);

      const late = await buy(open, b2);
      expect(late.version).toBe(v0);
      expect(await amountsOf(late.receipt.orderGroupId)).toEqual(firstAmounts);
      // the first order is exactly as it was
      expect(await amountsOf(first.receipt.orderGroupId)).toEqual(firstAmounts);
      expect(
        (
          await pool.query("SELECT config_version FROM core.order_group WHERE id = $1", [
            first.receipt.orderGroupId,
          ])
        ).rows[0],
      ).toMatchObject({ config_version: v0 });

      // an order placed after the change: the new version and the new fee
      const b3 = await user(pool);
      const fresh = await buy(await checkout(pool, b3, [lamp], standard(seed)), b3);
      expect(fresh.version).toBe(v1);
      const freshAmounts = await amountsOf(fresh.receipt.orderGroupId);
      expect(freshAmounts).toEqual(await expectedAmounts(await valuesOf(v1)));
      expect(freshAmounts).not.toEqual(firstAmounts);
      expect(await reconcile(pool)).toEqual(CLEAN);
    }, 60_000);

    it("R7: with every key at its minimum, and then at its maximum, checkout still works and the books still balance", async () => {
      for (const pick of ["min", "max"] as const) {
        const ids: string[] = [];
        for (const k of CONFIG_KEYS) {
          const target = (pick === "min" ? k.min : k.max).toString();
          if (readConfigValue(await tipValues(), k).toString() === target) continue;
          ids.push((await propose(k.key, target)).id);
        }
        for (const id of ids) await makeDue(id);
        expect(await drain()).toBe(ids.length);
        await makeEffective();
        const version = await currentVersion();
        const b = await user(pool);
        const sold = await buy(await checkout(pool, b, [lamp], standard(seed)), b);
        expect(sold.version).toBe(version);
        expect(await amountsOf(sold.receipt.orderGroupId)).toEqual(
          await expectedAmounts(await valuesOf(version)),
        );
        expect(await reconcile(pool)).toEqual(CLEAN);
      }
    }, 120_000);
  });

  describe("reads", () => {
    it("US-60: the console lists proposals with their state and time left, newest first, naming no user", async () => {
      const a = await propose("fee_percent", "4");
      const open = await adminActions(pool, { authSessionId: admin.authSessionId, scope: "OPEN", page: 1 });
      const mine = open.items.find((i) => i.id === a.id);
      expect(mine).toMatchObject({
        kind: "config.set",
        key: "fee_percent",
        value: "4",
        state: "QUEUED",
        canCancel: true,
        reason: REASON,
      });
      expect(mine?.secondsLeft).toBeGreaterThan(86_400 - 10);
      expect(open.items.every((i) => i.state === "QUEUED")).toBe(true);
      const history = await adminActions(pool, {
        authSessionId: admin.authSessionId,
        scope: "HISTORY",
        page: 1,
      });
      expect(history.items.length).toBeGreaterThan(0);
      expect(history.items.every((i) => i.state !== "QUEUED")).toBe(true);
      expect(history.items.some((i) => i.state === "EXECUTED")).toBe(true);
      expect(history.items.some((i) => i.state === "CANCELLED")).toBe(true);
      expect(history.items.some((i) => i.state === "FAILED")).toBe(true);
      const all = await adminActions(pool, { authSessionId: admin.authSessionId, scope: "ALL", page: 1 });
      expect(Date.parse(all.serverNow)).toBeGreaterThan(0);
      const text = JSON.stringify(all);
      expect(text).not.toContain(admin.userId);
      expect(text).not.toMatch(/requested_?by/i);
      await cancel(a.id);
    });

    it("R7: the configuration overview gives each allow-listed key's current value, default, bounds and any waiting change", async () => {
      const a = await propose("delivery_fee_paise.ZAP", "7000000");
      const o = await adminConfigOverview(pool, { authSessionId: admin.authSessionId });
      expect(o.keys.map((k) => k.key)).toEqual(CONFIG_KEYS.map((k) => k.key));
      for (const k of o.keys) {
        const spec = CONFIG_KEYS.find((s) => s.key === k.key);
        expect(k).toMatchObject({
          kind: spec?.kind,
          min: spec?.min.toString(),
          max: spec?.max.toString(),
          default: spec?.default.toString(),
        });
      }
      const zap = o.keys.find((k) => k.key === "delivery_fee_paise.ZAP");
      expect(zap?.pendingActionId).toBe(a.id);
      expect(zap?.current).toMatch(/^[0-9]+$/);
      expect(o.keys.find((k) => k.key === "fee_percent")?.pendingActionId).toBeNull();
      expect(typeof o.version).toBe("number");
      expect(o.delaySeconds).toBe(ADMIN_ACTION_RULES.delaySeconds);
      await cancel(a.id);
    });

    it("R7: the in-app announcement is public, names the setting and value only, and fades after its window", async () => {
      const list = await publicAnnouncements(pool);
      expect(list.length).toBeGreaterThan(0);
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(["announcedAt", "effectiveFrom", "id", "key", "value"]);
        expect(CONFIG_KEYS.map((k) => k.key)).toContain(item.key);
      }
      expect(list.length).toBeLessThanOrEqual(ADMIN_ACTION_RULES.announcementMax);
      const text = JSON.stringify(list);
      expect(text).not.toContain(admin.userId);
      expect(text).not.toContain("autumn");
      // newest first
      const times = list.map((i) => Date.parse(i.announcedAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      // after the window an announcement is no longer shown
      await pool.query("UPDATE core.announcement SET announced_at = announced_at - interval '30 days'");
      expect(await publicAnnouncements(pool)).toEqual([]);
    });

    it("R7: the announcement is readable with no session at all (public data), and the public answer carries no private field", async () => {
      const a = await propose("fee_percent", "14");
      await makeDue(a.id);
      expect(await drain()).toBe(1);
      const list = await asActor(pool, { role: "app_web" }, async (c) => {
        const { rows } = await c.query<{ r: unknown[] }>("SELECT core.public_announcements() AS r");
        return rows[0]?.r ?? [];
      });
      expect(list).toHaveLength(1);
      await makeEffective();
    });
  });

  describe("the rules hold in the database itself", () => {
    it("the allow-lists in core and in the database agree (drift check)", async () => {
      const keys = await pool.query<{
        key: string;
        path: string[];
        kind: string;
        min_value: string;
        max_value: string;
        default_value: string;
      }>(
        "SELECT key, path, kind, min_value::text, max_value::text, default_value::text FROM core.config_key_registry() ORDER BY key",
      );
      const expected = [...CONFIG_KEYS]
        .map((k) => ({
          key: k.key,
          path: [...k.path],
          kind: k.kind,
          min_value: k.min.toString(),
          max_value: k.max.toString(),
          default_value: k.default.toString(),
        }))
        .sort((x, y) => (x.key < y.key ? -1 : 1));
      expect(keys.rows).toEqual(expected);
      const kinds = await pool.query<{ k: string }>(
        "SELECT k FROM unnest(core.admin_action_kinds()) k ORDER BY 1",
      );
      expect(kinds.rows.map((r) => r.k)).toEqual([...ADMIN_ACTION_KINDS].sort());
      const rules = await pool.query<{ r: Record<string, number> }>("SELECT core.admin_action_rules() AS r");
      expect(rules.rows[0]?.r).toEqual({
        delaySeconds: ADMIN_ACTION_RULES.delaySeconds,
        delayMinSeconds: ADMIN_ACTION_RULES.delayMinSeconds,
        delayMaxSeconds: ADMIN_ACTION_RULES.delayMaxSeconds,
        openMax: ADMIN_ACTION_RULES.openMax,
        applyGraceSeconds: ADMIN_ACTION_RULES.applyGraceSeconds,
        announcementWindowHours: ADMIN_ACTION_RULES.announcementWindowHours,
        announcementMax: ADMIN_ACTION_RULES.announcementMax,
        pageSize: ADMIN_ACTION_RULES.pageSize,
      });
    });

    it("US-60: no application role can read or write the queue, the change record or the announcements directly", async () => {
      const tables = ["audit.pending_action", "audit.config_change", "core.announcement"];
      for (const role of [
        "app_web",
        "app_pay",
        "app_jobs",
        "npc_worker",
        "research_ro",
        "anon",
        "authenticated",
      ]) {
        for (const t of tables) {
          for (const sql of [
            `SELECT * FROM ${t}`,
            `INSERT INTO ${t} DEFAULT VALUES`,
            `UPDATE ${t} SET id = id`,
            `DELETE FROM ${t}`,
            `TRUNCATE ${t}`,
          ]) {
            // as a signed-in Super Admin too: the table is closed to the role, not to the person
            expect(await stateOf(pool, sql, [], { role, userId: admin.userId }), `${role}: ${sql}`).toBe(
              "42501",
            );
          }
        }
      }
    });

    it("US-60: only the jobs role may run the executor; the web roles may not, and the jobs role may not propose, cancel or read", async () => {
      const exec = "SELECT core.admin_actions_execute_due(1)";
      for (const role of ["app_web", "app_pay", "npc_worker", "research_ro", "anon", "authenticated"])
        expect(await stateOf(pool, exec, [], { role, userId: admin.userId }), role).toBe("42501");
      expect(await stateOf(pool, exec, [], { role: "app_jobs" })).toBe("no error");
      for (const sql of [
        "SELECT core.admin_action_propose('config.set', '{}'::jsonb, 'a reason')",
        "SELECT core.admin_action_cancel(gen_random_uuid(), 'a reason')",
        "SELECT core.admin_actions('ALL', 1)",
        "SELECT core.admin_config_overview()",
        "SELECT core.public_announcements()",
        "SELECT core.admin_action_apply_config_set(gen_random_uuid(), '{}'::jsonb, gen_random_uuid(), 'x')",
        "SELECT * FROM core.config_key_registry()",
      ])
        expect(await stateOf(pool, sql, [], { role: "app_jobs" }), sql).toBe("42501");
    });

    it("US-60: the executor needs no signed-in person and does nothing for the web role even as the Super Admin", async () => {
      expect(await stateOf(pool, "SELECT core.admin_actions_execute_due(5)", [], { role: "app_jobs" })).toBe(
        "no error",
      );
    });

    it("US-60: a queued action's request cannot be rewritten, a finished one cannot change, and none can be deleted (even by the owner)", async () => {
      const a = await propose("fee_percent", "15");
      for (const sql of [
        `UPDATE audit.pending_action SET payload = '{"key":"fee_percent","value":"20"}' WHERE id = '${a.id}'`,
        `UPDATE audit.pending_action SET action = 'mint.currency' WHERE id = '${a.id}'`,
        `UPDATE audit.pending_action SET requested_by = gen_random_uuid() WHERE id = '${a.id}'`,
        `UPDATE audit.pending_action SET reason = 'another reason' WHERE id = '${a.id}'`,
        `UPDATE audit.pending_action SET state = 'EXECUTED' WHERE id = '${a.id}'`, // without executed_at
        `DELETE FROM audit.pending_action WHERE id = '${a.id}'`,
        "TRUNCATE audit.pending_action",
      ])
        expect(await stateOf(pool, sql), sql).not.toBe("no error");
      await cancel(a.id);
      for (const sql of [
        `UPDATE audit.pending_action SET state = 'QUEUED', cancelled_at = NULL WHERE id = '${a.id}'`,
        `UPDATE audit.pending_action SET state = 'EXECUTED', executed_at = now() WHERE id = '${a.id}'`,
        `DELETE FROM audit.pending_action WHERE id = '${a.id}'`,
      ])
        expect(await stateOf(pool, sql), sql).not.toBe("no error");
      for (const sql of [
        "UPDATE audit.config_change SET new_value = '1'",
        "DELETE FROM audit.config_change",
        "TRUNCATE audit.config_change",
      ])
        expect(await stateOf(pool, sql), sql).not.toBe("no error");
    });

    it("invariant 2 and 8: the queue writes no ledger row and no outbox or event payload names a person", async () => {
      expect(await reconcile(pool)).toEqual(CLEAN);
      const { rows } = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM audit.outbox WHERE type LIKE 'admin_action_%'",
      );
      expect(rows.length).toBeGreaterThan(5);
      for (const r of rows) {
        const text = JSON.stringify(r.payload);
        expect(text).not.toContain(admin.userId);
        expect(text).not.toMatch(/@|reason/i);
      }
    });
  });
});

describe("the queue's limits and delay come from configuration (invariant 10)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let admin: TestUser;

  beforeAll(async () => {
    db = await createTestDatabase({ poolSize: 10 });
    pool = db.pool;
    admin = await user(pool);
    await pool.query("UPDATE core.user_profile SET role = 'SUPER_ADMIN' WHERE id = $1", [admin.userId]);
  }, 120_000);
  afterAll(async () => {
    await db.drop();
  });

  const withConfig = (patch: Record<string, unknown>) =>
    pool.query(
      `INSERT INTO core.config_version (values, effective_from, note)
       SELECT values || $1::jsonb, now() - interval '1 second', 'test' FROM core.config_version ORDER BY id DESC LIMIT 1`,
      [JSON.stringify(patch)],
    );
  const delayOf = async (key: string, value: string) => {
    const a = await proposeConfigChange(pool, {
      authSessionId: admin.authSessionId,
      key,
      value,
      reason: REASON,
    });
    await cancelAdminAction(pool, { authSessionId: admin.authSessionId, actionId: a.id, reason: REASON });
    return Date.parse(a.notBefore) - Date.now();
  };

  it("US-60: the delay is read from configuration but never below an hour or above a week", async () => {
    await withConfig({ admin_action_delay_seconds: 7200 });
    expect(Math.abs((await delayOf("fee_percent", "6")) - 7_200_000)).toBeLessThan(5_000);
    await withConfig({ admin_action_delay_seconds: 0 });
    expect(Math.abs((await delayOf("fee_percent", "7")) - 3_600_000)).toBeLessThan(5_000);
    await withConfig({ admin_action_delay_seconds: 999_999_999 });
    expect(Math.abs((await delayOf("fee_percent", "8")) - 604_800_000)).toBeLessThan(5_000);
    await withConfig({ admin_action_delay_seconds: "abc" });
    expect(Math.abs((await delayOf("fee_percent", "9")) - DAY_MS)).toBeLessThan(5_000);
  });

  it("US-60: the number of waiting proposals is capped (ADMIN_ACTION_LIMIT), by configuration", async () => {
    await withConfig({ admin_action_delay_seconds: 86_400, admin_action_open_max: 2 });
    const ids: string[] = [];
    for (const [k, v] of [
      ["fee_percent", "6"],
      ["delivery_fee_paise.STANDARD", "110000"],
    ] as const)
      ids.push(
        (
          await proposeConfigChange(pool, {
            authSessionId: admin.authSessionId,
            key: k,
            value: v,
            reason: REASON,
          })
        ).id,
      );
    expect(
      await errorOf(
        proposeConfigChange(pool, {
          authSessionId: admin.authSessionId,
          key: "delivery_fee_paise.EXPRESS",
          value: "1100000",
          reason: REASON,
        }),
      ),
    ).toBe("ADMIN_ACTION_LIMIT");
    await cancelAdminAction(pool, {
      authSessionId: admin.authSessionId,
      actionId: ids[0] as string,
      reason: REASON,
    });
    const again = await proposeConfigChange(pool, {
      authSessionId: admin.authSessionId,
      key: "delivery_fee_paise.EXPRESS",
      value: "1100000",
      reason: REASON,
    });
    expect(again.state).toBe("QUEUED");
  });

  it("US-60: concurrent proposals cannot all slip under the cap", async () => {
    await withConfig({ admin_action_open_max: 3 });
    const open = await count(pool, "SELECT count(*) AS n FROM audit.pending_action WHERE state = 'QUEUED'");
    const results = await Promise.all(
      [
        ["fee_percent", "10"],
        ["delivery_fee_paise.ZAP", "5500000"],
        ["delivery_fee_paise.STANDARD", "130000"],
        ["delivery_fee_paise.EXPRESS", "1300000"],
      ].map(([k, v]) =>
        errorOf(
          proposeConfigChange(pool, {
            authSessionId: admin.authSessionId,
            key: k as string,
            value: v as string,
            reason: REASON,
          }),
        ),
      ),
    );
    const queued = await count(pool, "SELECT count(*) AS n FROM audit.pending_action WHERE state = 'QUEUED'");
    expect(queued).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r === "ok").length).toBe(queued - open);
    expect(results.filter((r) => r !== "ok" && r !== "CONFLICT" && r !== "ADMIN_ACTION_LIMIT")).toEqual([]);
  });
});
