import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, newIdempotencyKey, resetCsrf, setSleepForTests } from "./api";
import { parsePaise } from "./money";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const headersOf = (call: Parameters<typeof fetch> | undefined): Record<string, string> =>
  (call?.[1]?.headers ?? {}) as Record<string, string>;
const failure = (status: number, code: string, retryable: boolean) =>
  json(status, { error: { code, message: `${code} message`, retryable, details: {} } });

describe("api client", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setSleepForTests(async () => {});
    resetCsrf();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSleepForTests(null);
  });

  it("sends the CSRF header on writes only, and caches the token", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith("/csrf") ? json(200, { csrfToken: "tok" }) : json(200, { ok: true }),
    );
    await api("/api/v1/me");
    await api("/api/v1/x", { method: "POST", body: {} });
    await api("/api/v1/y", { method: "POST", body: {} });
    const calls = fetchMock.mock.calls;
    expect(calls.filter(([url]) => String(url).endsWith("/csrf"))).toHaveLength(1);
    const get = calls.find(([url]) => url === "/api/v1/me");
    expect(headersOf(get)["x-csrf-token"]).toBeUndefined();
    const post = calls.find(([url]) => url === "/api/v1/x");
    expect(headersOf(post)["x-csrf-token"]).toBe("tok");
    expect(post?.[1]?.credentials).toBe("same-origin");
  });

  it("throws a typed ApiError and does not retry a non-retryable error", async () => {
    fetchMock.mockResolvedValue(failure(422, "PIN_INCORRECT", false));
    await expect(api("/api/v1/me")).rejects.toMatchObject({ code: "PIN_INCORRECT", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors with the same idempotency key, at most three times", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).endsWith("/csrf") ? json(200, { csrfToken: "tok" }) : failure(503, "BUSY", true),
    );
    const key = newIdempotencyKey();
    const error = await api("/api/v1/pay", { method: "POST", body: {}, idempotencyKey: key }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const posts = fetchMock.mock.calls.filter(([url]) => url === "/api/v1/pay");
    expect(posts).toHaveLength(4);
    const keys = new Set(posts.map((call) => headersOf(call)["idempotency-key"]));
    expect(keys).toEqual(new Set([key]));
  });

  it("does not replay a write after a network failure unless it carries a key", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/csrf")) return json(200, { csrfToken: "tok" });
      throw new TypeError("network down");
    });
    await expect(api("/api/v1/z", { method: "POST", body: {} })).rejects.toMatchObject({ code: "NETWORK" });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/z")).toHaveLength(1);
  });

  it("refreshes the CSRF token once when the server refuses it", async () => {
    let tokens = 0;
    let posts = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/csrf")) return json(200, { csrfToken: `t${++tokens}` });
      return ++posts === 1 ? failure(403, "FORBIDDEN", false) : json(200, { ok: true });
    });
    await expect(api("/api/v1/w", { method: "POST", body: {} })).resolves.toEqual({ ok: true });
    expect(tokens).toBe(2);
  });
});

describe("money parsing", () => {
  it("parses large amounts exactly", () => {
    expect(parsePaise("10000000000000000")).toBe(10_000_000_000_000_000n);
    expect(parsePaise("-5")).toBe(-5n);
  });
  it("rejects anything that is not integer paise", () => {
    expect(() => parsePaise("1.5")).toThrow();
    expect(() => parsePaise("abc")).toThrow();
  });
});
