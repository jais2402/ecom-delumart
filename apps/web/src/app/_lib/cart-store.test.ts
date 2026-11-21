import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrf, setSleepForTests } from "./api";
import {
  addToCart,
  hydrateCart,
  LOCAL_CART_KEY,
  MAX_LOCAL_LINES,
  removeFromCart,
  resetCartForTests,
  syncCartWithSession,
} from "./cart-store";
import type { SessionState } from "./session-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

const cartBody = (ids: string[]) => ({
  lineCount: ids.length,
  maxLines: 20,
  groups: ids.length
    ? [
        {
          sellerKey: "SEED",
          sellerName: "DeluluMart Originals",
          lines: ids.map((productId) => ({ productId })),
        },
      ]
    : [],
  preview: null,
  previewError: null,
});

const finished: SessionState = {
  status: "signedIn",
  handle: "h",
  balancePaise: 1n,
  account: null,
  onboarding: {
    hasProfile: true,
    phoneVerified: true,
    hasBirthdate: true,
    isAdult: true,
    provisioned: true,
    pinSet: true,
  },
};

describe("cart store", () => {
  let storage: MemoryStorage;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    setSleepForTests(async () => {});
    resetCsrf();
    resetCartForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSleepForTests(null);
  });

  it("signed out: keeps ids only in localStorage, once each, up to the limit", async () => {
    expect((await addToCart(id(1))).status).toBe("added");
    expect((await addToCart(id(1))).status).toBe("already");
    expect(JSON.parse(storage.getItem(LOCAL_CART_KEY) ?? "null")).toEqual([id(1)]);
    for (let n = 2; n <= MAX_LOCAL_LINES; n++) await addToCart(id(n));
    const full = await addToCart(id(99));
    expect(full.status).toBe("full");
    expect(JSON.parse(storage.getItem(LOCAL_CART_KEY) ?? "[]")).toHaveLength(MAX_LOCAL_LINES);
    // nothing but ids is stored, under one key
    expect([...storage.data.keys()]).toEqual([LOCAL_CART_KEY]);
    expect(storage.getItem(LOCAL_CART_KEY)).toMatch(/^\["[0-9a-f-]{36}"(,"[0-9a-f-]{36}")*\]$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a local line and drops the key when the cart is empty", async () => {
    await addToCart(id(1));
    await removeFromCart(id(1));
    expect(storage.getItem(LOCAL_CART_KEY)).toBeNull();
  });

  it("hydrates only valid ids from storage", () => {
    storage.setItem(LOCAL_CART_KEY, JSON.stringify([id(1), "not-an-id", 7, id(1)]));
    hydrateCart();
    // a later add keeps the one valid id and appends
    return addToCart(id(2)).then(() => {
      expect(JSON.parse(storage.getItem(LOCAL_CART_KEY) ?? "[]")).toEqual([id(1), id(2)]);
    });
  });

  it("merges once at sign-in, clears the local copy and reports skipped items", async () => {
    await addToCart(id(1));
    await addToCart(id(2));
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/csrf")) return json(200, { csrfToken: "t" });
      if (url.endsWith("/cart/merge"))
        return json(200, { ...cartBody([id(1)]), skipped: [{ productId: id(2), reason: "ALREADY_OWNED" }] });
      if (url.includes("/products/")) return json(200, { name: "Pocket Comet" });
      return json(200, {});
    });
    syncCartWithSession(finished);
    syncCartWithSession(finished); // a second call while merging must not merge again
    await vi.waitFor(() => expect(storage.getItem(LOCAL_CART_KEY)).toBeNull());
    const merges = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cart/merge"));
    expect(merges).toHaveLength(1);
    expect(JSON.parse(String(merges[0]?.[1]?.body))).toEqual({ productIds: [id(1), id(2)] });
  });

  it("signed in: add goes to the server cart, not to storage", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/csrf")) return json(200, { csrfToken: "t" });
      if (url.endsWith("/cart")) return json(200, cartBody([]));
      if (url.endsWith("/cart/lines")) return json(200, cartBody([id(5)]));
      return json(200, {});
    });
    syncCartWithSession(finished);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/cart"))).toBe(true),
    );
    expect((await addToCart(id(5))).status).toBe("added");
    expect(storage.getItem(LOCAL_CART_KEY)).toBeNull();
  });

  it("maps a server refusal to a plain result", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/csrf")) return json(200, { csrfToken: "t" });
      if (url.endsWith("/cart")) return json(200, cartBody([]));
      return json(409, { error: { code: "CART_FULL", message: "full", retryable: false, details: {} } });
    });
    syncCartWithSession(finished);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/v1/cart"))).toBe(true),
    );
    const result = await addToCart(id(6));
    expect(result.status).toBe("full");
  });
});
