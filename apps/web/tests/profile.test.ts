import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as profile from "../src/app/api/v1/profile/route";
import { startTestApp, type TestApp } from "./helpers/app";
import { Browser, str } from "./helpers/browser";
import { player, R } from "./helpers/flows";

/** POST /api/v1/profile: own handle, privacy switches and research opt-out. */
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
}, 120_000);

afterAll(async () => {
  await app.stop();
});

const update = (b: Browser, body: unknown, options: Parameters<Browser["call"]>[3] = {}) =>
  b.call(profile.POST, "POST", "/api/v1/profile", { body, ...options });

const uniqueHandle = () => `p-${Math.random().toString(36).slice(2, 10)}`;

describe("POST /api/v1/profile", () => {
  it("the owner can update handle, privacy and research opt-out; the response is private", async () => {
    const { b } = await player({ pin: false });
    const handle = uniqueHandle();
    const res = await update(b, {
      handle,
      privacy: { publicShelf: true, showHandleOnPurchases: false },
      researchOptOut: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.json).toMatchObject({
      handle,
      privacy: { publicShelf: true, showHandleOnPurchases: false },
      researchOptOut: true,
    });
    // the change is visible on /me, and an empty body reads the profile back unchanged
    const me = await b.call(R.me.GET, "GET", "/api/v1/me");
    expect(str(me.json.profile?.handle)).toBe(handle);
    const again = await update(b, {});
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ handle, researchOptOut: true });
  });

  it("rejects a malformed handle", async () => {
    const { b } = await player({ pin: false });
    for (const handle of ["ab", "Has Space", "UPPER", "x".repeat(25), "bad_underscore"]) {
      const res = await update(b, { handle });
      expect(res.status, handle).toBe(400);
      expect(res.json.error?.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects unknown fields", async () => {
    const { b } = await player({ pin: false });
    expect((await update(b, { email: "a@example.test" })).status).toBe(400);
    expect((await update(b, { privacy: { sneaky: true } })).status).toBe(400);
  });

  it("rejects a reserved handle and a handle someone else holds", async () => {
    const { b } = await player({ pin: false });
    const reserved = await update(b, { handle: "admin" });
    expect(reserved.status).toBe(409);
    expect(reserved.json.error?.code).toBe("CONFLICT");

    const other = await player({ pin: false });
    const taken = uniqueHandle();
    expect((await update(other.b, { handle: taken })).status).toBe(200);
    const clash = await update(b, { handle: taken });
    expect(clash.status).toBe(409);
  });

  it("answers 401 without a session", async () => {
    const b = new Browser();
    const token = await b.call(R.csrf.GET, "GET", "/api/v1/auth/csrf");
    b.csrfToken = str(token.json.csrfToken);
    const res = await update(b, { researchOptOut: true });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("AUTH_REQUIRED");
  });

  it("enforces origin and the CSRF token", async () => {
    const { b } = await player({ pin: false });
    expect((await update(b, { researchOptOut: true }, { csrf: false })).status).toBe(403);
    expect((await update(b, { researchOptOut: true }, { csrf: "wrong-token" })).status).toBe(403);
    expect((await update(b, { researchOptOut: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await update(b, { researchOptOut: true }, { origin: null })).status).toBe(403);
  });
});
