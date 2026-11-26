import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cancelRoute from "../src/app/api/v1/admin/actions/[id]/cancel/route";
import * as actionsRoute from "../src/app/api/v1/admin/actions/route";
import * as configRoute from "../src/app/api/v1/admin/config/route";
import * as announcementsRoute from "../src/app/api/v1/announcements/route";
import { settleTracking } from "../src/server/analytics";
import { PUBLIC_SHORT_CACHE } from "../src/server/http";
import { startTestApp, type TestApp } from "./helpers/app";
import { arr, Browser, type CallResult, str } from "./helpers/browser";
import { player } from "./helpers/flows";
import { makeAdmin, runJobs, userIdOf } from "./helpers/studio";

/**
 * The Super Admin's 24-hour delayed, cancellable actions and versioned configuration through the
 * routes and the jobs endpoint (migration 0090; PRD R16.6, R7; US-60; docs/decisions.md #16).
 */
let app: TestApp;
let admin: Browser;
let adminId = "";
const REASON = "Seasonal change agreed after reviewing the numbers";
const DAY_MS = 86_400_000;

beforeAll(async () => {
  app = await startTestApp();
  admin = (await player({ pin: false })).b;
  await makeAdmin(app, admin);
  adminId = await userIdOf(app, admin);
}, 120_000);

afterAll(async () => {
  await app.stop();
});

function expectError(res: CallResult, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.json.error?.code).toBe(code);
}

const propose = (b: Browser, key: string, value: string, reason = REASON, extra = {}) =>
  b.call(configRoute.POST, "POST", "/api/v1/admin/config", { body: { key, value, reason }, ...extra });
const cancel = (b: Browser, id: string, reason = "Not needed after all", extra = {}) =>
  b.call(cancelRoute.POST, "POST", `/api/v1/admin/actions/${id}/cancel`, {
    params: { id },
    body: { reason },
    ...extra,
  });
const list = (b: Browser, query = "") => b.call(actionsRoute.GET, "GET", `/api/v1/admin/actions${query}`);
const makeDue = (id: string) =>
  app.db.pool.query(
    "UPDATE audit.pending_action SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1",
    [id],
  );

describe("proposing and cancelling through the routes", () => {
  it("US-60: the Super Admin queues a change for 24 hours; the answer is private and names no user", async () => {
    const t0 = Date.now();
    const res = await propose(admin, "fee_percent", "7");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const action = res.json.action;
    expect(action).toMatchObject({
      kind: "config.set",
      key: "fee_percent",
      value: "7",
      state: "QUEUED",
      canCancel: true,
    });
    const waitMs = Date.parse(str(action?.notBefore)) - t0;
    expect(waitMs).toBeGreaterThan(DAY_MS - 10_000);
    expect(waitMs).toBeLessThan(DAY_MS + 10_000);
    expect(res.text).not.toContain(adminId);
    // nothing changed yet
    const overview = await admin.call(configRoute.GET, "GET", "/api/v1/admin/config");
    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toBe("private, no-store");
    const fee = arr(overview.json.keys).find((k) => k.key === ("fee_percent" as unknown));
    expect(fee).toMatchObject({
      current: "5",
      default: "5",
      min: "0",
      max: "20",
      pendingActionId: str(action?.id),
    });
    expect(await cancel(admin, str(action?.id))).toMatchObject({ status: 200 });
  });

  it("US-60: it is refused for anyone but the Super Admin, without a CSRF token, and with a stale sign-in", async () => {
    const other = (await player({ pin: false })).b;
    expectError(await propose(other, "fee_percent", "8"), 403, "FORBIDDEN");
    expectError(await list(other), 403, "FORBIDDEN");
    expectError(await other.call(configRoute.GET, "GET", "/api/v1/admin/config"), 403, "FORBIDDEN");
    expectError(await propose(admin, "fee_percent", "8", REASON, { csrf: false }), 403, "FORBIDDEN");
    expectError(
      await propose(admin, "fee_percent", "8", REASON, { origin: "https://evil.example" }),
      403,
      "FORBIDDEN",
    );
    const sessionIds = [...admin.jar.values()].filter((v) => /^[0-9a-f-]{36}$/i.test(v));
    await app.db.pool.query(
      "UPDATE auth.sessions SET created_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])",
      [sessionIds],
    );
    try {
      expectError(await propose(admin, "fee_percent", "8"), 401, "REAUTH_REQUIRED");
      expect((await list(admin)).status).toBe(200); // reading needs no recent sign-in
    } finally {
      await app.db.pool.query("UPDATE auth.sessions SET created_at = now() WHERE id = ANY($1::uuid[])", [
        sessionIds,
      ]);
    }
    expect(
      (await app.db.pool.query("SELECT count(*)::int AS n FROM audit.pending_action WHERE state = 'QUEUED'"))
        .rows[0],
    ).toEqual({ n: 0 });
  });

  it("R7: a key outside the allow-list, a value outside its bounds or a malformed body is refused with a stable code", async () => {
    expectError(await propose(admin, "starter_grant_paise", "1"), 422, "CONFIG_KEY_UNKNOWN");
    expectError(await propose(admin, "fee_percent", "21"), 422, "CONFIG_VALUE_INVALID");
    expectError(await propose(admin, "fee_percent", "-1"), 422, "CONFIG_VALUE_INVALID");
    expectError(await propose(admin, "delivery_fee_paise.ZAP", "10000001"), 422, "CONFIG_VALUE_INVALID");
    expectError(await propose(admin, "fee_percent", "6.5"), 422, "CONFIG_VALUE_INVALID");
    expectError(await propose(admin, "fee_percent", "6", "no"), 422, "VALIDATION_FAILED");
    expectError(
      await propose(admin, "fee_percent", "6", "mail me at a@b.example please"),
      422,
      "VALIDATION_FAILED",
    );
    expectError(await propose(admin, "fee_percent", "5"), 409, "CONFLICT"); // already the value
    const extra = await admin.call(configRoute.POST, "POST", "/api/v1/admin/config", {
      body: { key: "fee_percent", value: "6", reason: REASON, approver: "me" },
    });
    expectError(extra, 400, "VALIDATION_FAILED");
    expectError(
      await admin.call(configRoute.POST, "POST", "/api/v1/admin/config", {
        body: { key: "fee_percent", value: 6, reason: REASON },
      }),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("US-60: a waiting action is cancelled once; a second cancel and an unknown action are refused", async () => {
    const queued = await propose(admin, "delivery_fee_paise.STANDARD", "120000");
    const id = str(queued.json.action?.id);
    expect(arr((await list(admin, "?scope=OPEN")).json.items).map((i) => i.id)).toContain(id as never);
    const done = await cancel(admin, id, "Changed my mind about this");
    expect(done.status).toBe(200);
    expect(done.json.action).toMatchObject({
      id,
      state: "CANCELLED",
      cancelReason: "Changed my mind about this",
      canCancel: false,
    });
    expectError(await cancel(admin, id), 409, "CONFLICT");
    expectError(await cancel(admin, "0192f6a0-0000-4000-8000-0000000000ff"), 404, "NOT_FOUND");
    expectError(await cancel(admin, id, "x"), 422, "VALIDATION_FAILED");
    const other = (await player({ pin: false })).b;
    expectError(await cancel(other, id), 403, "FORBIDDEN");
    const history = await list(admin, "?scope=HISTORY");
    expect(
      arr(history.json.items).some((i) => i.id === (id as never) && i.state === ("CANCELLED" as never)),
    ).toBe(true);
    expectError(await list(admin, "?scope=NOPE"), 400, "VALIDATION_FAILED");
    expectError(await list(admin, "?page=0"), 400, "VALIDATION_FAILED");
  });
});

describe("the jobs step and the public announcement", () => {
  it("US-60: the signed jobs run executes a due action once, a new version applies, and the storefront announces it", async () => {
    const before = await app.db.pool.query<{ n: number; maxid: number }>(
      "SELECT count(*)::int AS n, max(id)::int AS maxid FROM core.config_version",
    );
    const queued = await propose(admin, "fee_percent", "9", "Autumn fee review");
    const id = str(queued.json.action?.id);
    // not due: a run does nothing
    expect(await runJobs()).toBe(200);
    expect(
      (await app.db.pool.query("SELECT state FROM audit.pending_action WHERE id = $1", [id])).rows[0],
    ).toEqual({ state: "QUEUED" });
    expect(
      (
        (await app.db.pool.query("SELECT count(*)::int AS n FROM core.config_version")).rows[0] as {
          n: number;
        }
      ).n,
    ).toBe(before.rows[0]?.n);
    // due: executed exactly once, however many runs
    await makeDue(id);
    expect(await runJobs()).toBe(200);
    expect(await runJobs()).toBe(200);
    const after = await app.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.config_version",
    );
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);
    const row = await app.db.pool.query("SELECT state, outcome FROM audit.pending_action WHERE id = $1", [
      id,
    ]);
    expect(row.rows[0]).toMatchObject({ state: "EXECUTED", outcome: { changed: true } });
    // the console shows it as executed, with no user named
    const history = await list(admin, "?scope=HISTORY");
    expect(arr(history.json.items).find((i) => i.id === (id as never))).toMatchObject({
      state: "EXECUTED",
      canCancel: false,
      outcome: { changed: true },
    });
    expect(history.text).not.toContain(adminId);
    // a cancel after execution is refused
    expectError(await cancel(admin, id), 409, "CONFLICT");
    // the analytics event: no user, no props
    await settleTracking();
    const events = await app.db.pool.query(
      "SELECT props, visitor_key FROM analytics.event WHERE name = 'console_config_changed'",
    );
    expect(events.rows).toEqual([{ props: {}, visitor_key: null }]);

    // the public banner route: no session, public cache, the setting and the value only
    const anon = new Browser();
    const res = await anon.call(announcementsRoute.GET, "GET", "/api/v1/announcements");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_SHORT_CACHE);
    expect(res.headers.getSetCookie()).toEqual([]);
    const items = arr(res.json.items);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "announcedAt",
      "effectiveFrom",
      "id",
      "key",
      "value",
    ]);
    expect(items[0]).toMatchObject({ key: "fee_percent", value: "9" });
    for (const secret of [adminId, "Autumn", REASON, "reason", "requested"])
      expect(res.text).not.toContain(secret);
    // the same answer for a signed-in admin: the public route never reads the session
    const asAdmin = await admin.call(announcementsRoute.GET, "GET", "/api/v1/announcements");
    expect(asAdmin.text).toBe(res.text);
    expect(asAdmin.headers.get("cache-control")).toBe(PUBLIC_SHORT_CACHE);
    expect(asAdmin.headers.get("cache-control")).not.toMatch(/private/);
  }, 60_000);

  it("R7: a configuration change shows as the current value once its grace period has passed", async () => {
    await app.db.pool.query(
      "UPDATE core.config_version SET effective_from = clock_timestamp() WHERE effective_from > now()",
    );
    const overview = await admin.call(configRoute.GET, "GET", "/api/v1/admin/config");
    const fee = arr(overview.json.keys).find((k) => k.key === ("fee_percent" as unknown));
    expect(fee).toMatchObject({ current: "9", pendingActionId: null });
  });

  it("US-60: an action that fails at execution is marked FAILED, shows its code and is never retried", async () => {
    const id = "0192f6a0-0000-7000-8000-00000000aaaa";
    await app.db.pool.query(
      `INSERT INTO audit.pending_action (id, action, payload, payload_hash, requested_by, not_before, reason)
       VALUES ($1, 'config.set', '{"key":"price_min_paise","value":"1"}'::jsonb,
               sha256(convert_to('{"key": "price_min_paise", "value": "1"}', 'UTF8')), $2,
               clock_timestamp() - interval '1 second', 'planted by a test')`,
      [id, adminId],
    );
    expect(await runJobs()).toBe(200);
    const history = await list(admin, "?scope=HISTORY");
    expect(arr(history.json.items).find((i) => i.id === (id as never))).toMatchObject({
      state: "FAILED",
      outcome: { code: "CONFIG_KEY_UNKNOWN" },
    });
    const state = await app.db.pool.query("SELECT state FROM audit.pending_action WHERE id = $1", [id]);
    expect(state.rows[0]).toEqual({ state: "FAILED" });
  });
});
