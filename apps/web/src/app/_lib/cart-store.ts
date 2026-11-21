import { useSyncExternalStore } from "react";
import { ApiError, api, type CartMergeResponse, type CartResponse, type ProductResponse } from "./api";
import { nextOnboardingPath, type SessionState } from "./session-store";

/**
 * The cart as the browser sees it. Signed in with a finished account, the server cart is the only
 * truth. Otherwise the cart is a list of product ids in memory, mirrored to localStorage under one
 * key (ids only: never a price, a name or anything personal), at most MAX_LOCAL_LINES. When the
 * person finishes signing in, the ids are merged into the account cart once and the local copy is
 * cleared.
 */
export const LOCAL_CART_KEY = "dm.cart.v1";
export const MAX_LOCAL_LINES = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddResult =
  | { status: "added" | "already" }
  | { status: "full" | "owned" | "unavailable" | "self" | "error"; message: string };

export interface MergeNotice {
  merged: number;
  skipped: { productId: string; name: string; reason: string }[];
}

interface State {
  /** Product ids of the signed-out (or not yet onboarded) cart. */
  localIds: readonly string[];
  server: CartResponse | null;
  /** True once the server cart has been read (or the merge returned it). */
  serverReady: boolean;
  /** Whether the server cart is the source of truth right now. */
  serverMode: boolean;
  notice: MergeNotice | null;
  loadError: string | null;
  /** Set when a checkout was refused because lines changed; the cart page says nothing was charged. */
  changed: boolean;
}

const INITIAL: State = {
  localIds: [],
  server: null,
  serverReady: false,
  serverMode: false,
  notice: null,
  loadError: null,
  changed: false,
};

let state: State = INITIAL;
const listeners = new Set<() => void>();
let hydrated = false;
let merging = false;
let mergeFailed = false;
let loading: Promise<void> | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

// ------------------------------------------------------------------ local copy

function readLocal(): string[] {
  try {
    const raw = localStorage.getItem(LOCAL_CART_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((v): v is string => typeof v === "string" && UUID.test(v));
    return [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, MAX_LOCAL_LINES);
  } catch {
    return [];
  }
}

function writeLocal(ids: readonly string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(LOCAL_CART_KEY);
    else localStorage.setItem(LOCAL_CART_KEY, JSON.stringify(ids));
  } catch {
    // storage blocked: the in-memory list still works for this tab
  }
}

function setLocal(ids: readonly string[]): void {
  writeLocal(ids);
  set({ localIds: ids });
}

/** Read the saved ids once, after hydration (never during render, so server and client HTML match). */
export function hydrateCart(): void {
  if (hydrated) return;
  hydrated = true;
  const saved = readLocal();
  if (saved.length === 0) return;
  const merged = [...new Set([...saved, ...state.localIds])].slice(0, MAX_LOCAL_LINES);
  set({ localIds: merged });
}

// ------------------------------------------------------------------ server copy

const REASONS: Record<string, string> = {
  PRODUCT_UNAVAILABLE: "it is no longer for sale",
  ALREADY_OWNED: "it is already in your collection",
  SELF_PURCHASE: "it is your own product",
  CART_FULL: "your cart was already full (up to 20 items)",
};

export function skipReason(code: string): string {
  return REASONS[code] ?? "it could not be added";
}

async function nameOf(productId: string): Promise<string> {
  try {
    const product = await api<ProductResponse>(`/api/v1/products/${productId}`);
    return product.name;
  } catch {
    return "An item you added";
  }
}

/** Loads the account cart into the store. Safe to call repeatedly. */
export function refreshCart(): Promise<void> {
  if (!state.serverMode) return Promise.resolve();
  loading ??= (async () => {
    try {
      const cart = await api<CartResponse>("/api/v1/cart");
      set({ server: cart, serverReady: true, loadError: null });
    } catch (error) {
      set({ loadError: error instanceof ApiError ? error.message : "Could not load your cart." });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function mergeLocal(): Promise<void> {
  if (merging) return;
  merging = true;
  const ids = state.localIds.slice(0, MAX_LOCAL_LINES);
  try {
    const result = await api<CartMergeResponse>("/api/v1/cart/merge", {
      method: "POST",
      body: { productIds: ids },
    });
    setLocal([]);
    const skipped = await Promise.all(
      result.skipped.map(async (s) => ({
        productId: s.productId,
        name: await nameOf(s.productId),
        reason: skipReason(s.reason),
      })),
    );
    const { skipped: _skipped, ...cart } = result;
    set({
      server: cart,
      serverReady: true,
      loadError: null,
      notice: skipped.length > 0 ? { merged: ids.length - skipped.length, skipped } : null,
    });
  } catch {
    // keep the local ids; the cart page offers a retry through refresh()
    mergeFailed = true;
    await refreshCart();
  } finally {
    merging = false;
  }
}

/** Called whenever the session changes: picks the cart's source of truth and merges once. */
export function syncCartWithSession(session: SessionState): void {
  const finished =
    session.status === "signedIn" && nextOnboardingPath(session.onboarding, false) === "/account";
  if (!finished) {
    if (session.status === "loading") return;
    mergeFailed = false;
    if (state.serverMode || state.server) set({ serverMode: false, server: null, serverReady: false });
    return;
  }
  if (!state.serverMode) set({ serverMode: true, serverReady: false });
  if (state.localIds.length > 0 && !mergeFailed) void mergeLocal();
  else if (!state.serverReady) void refreshCart();
}

export function dismissCartNotice(): void {
  set({ notice: null });
}

/** A checkout was refused because lines changed: reload the cart and flag it for the cart page. */
export function markCartChanged(): Promise<void> {
  set({ changed: true });
  return refreshCart();
}

export function dismissCartChanged(): void {
  set({ changed: false });
}

// ------------------------------------------------------------------ actions

function failure(error: unknown): AddResult {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "CART_FULL":
        return { status: "full", message: "Your cart is full. Remove something to add this." };
      case "ALREADY_OWNED":
        return { status: "owned", message: "You already own this." };
      case "PRODUCT_UNAVAILABLE":
        return { status: "unavailable", message: "This product is not available right now." };
      case "SELF_PURCHASE":
        return { status: "self", message: "You cannot buy your own product." };
      default:
        return { status: "error", message: error.message };
    }
  }
  return { status: "error", message: "Could not update your cart. Try again." };
}

export async function addToCart(productId: string): Promise<AddResult> {
  const id = productId.toLowerCase();
  if (state.serverMode) {
    const had = state.server?.groups.some((g) => g.lines.some((l) => l.productId === id)) ?? false;
    if (had) return { status: "already" };
    try {
      const cart = await api<CartResponse>("/api/v1/cart/lines", { method: "POST", body: { productId: id } });
      set({ server: cart, serverReady: true });
      return { status: "added" };
    } catch (error) {
      return failure(error);
    }
  }
  if (state.localIds.includes(id)) return { status: "already" };
  if (state.localIds.length >= MAX_LOCAL_LINES) return failure(new ApiError("CART_FULL", "", false, 409));
  setLocal([...state.localIds, id]);
  return { status: "added" };
}

export async function removeFromCart(productId: string): Promise<void> {
  const id = productId.toLowerCase();
  if (state.serverMode) {
    const cart = await api<CartResponse>(`/api/v1/cart/lines/${id}`, { method: "DELETE" });
    set({ server: cart, serverReady: true });
    return;
  }
  setLocal(state.localIds.filter((existing) => existing !== id));
}

export async function clearCart(): Promise<void> {
  if (state.serverMode) {
    const cart = await api<CartResponse>("/api/v1/cart", { method: "DELETE" });
    set({ server: cart, serverReady: true });
    return;
  }
  setLocal([]);
}

/** Retry after a failed merge or load. */
export function retryCart(): Promise<void> {
  mergeFailed = false;
  if (state.serverMode && state.localIds.length > 0) return mergeLocal();
  return refreshCart();
}

// ------------------------------------------------------------------ hook

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface CartSnapshot extends State {
  count: number;
  /** Every product id in the cart, wherever it lives. */
  ids: readonly string[];
}

let cachedFor: State | null = null;
let cached: CartSnapshot = { ...INITIAL, count: 0, ids: [] };

function snapshot(): CartSnapshot {
  if (cachedFor === state) return cached;
  const serverIds = state.server?.groups.flatMap((g) => g.lines.map((l) => l.productId)) ?? [];
  const ids = state.serverMode ? serverIds : state.localIds;
  cachedFor = state;
  cached = {
    ...state,
    count: state.serverMode ? (state.server?.lineCount ?? 0) : state.localIds.length,
    ids,
  };
  return cached;
}

const SERVER_SNAPSHOT: CartSnapshot = { ...INITIAL, count: 0, ids: [] };

export function useCart(): CartSnapshot & {
  add: typeof addToCart;
  remove: typeof removeFromCart;
  clear: typeof clearCart;
  refresh: typeof retryCart;
  dismissNotice: typeof dismissCartNotice;
  dismissChanged: typeof dismissCartChanged;
} {
  const snap = useSyncExternalStore(subscribe, snapshot, () => SERVER_SNAPSHOT);
  return {
    ...snap,
    add: addToCart,
    remove: removeFromCart,
    clear: clearCart,
    refresh: retryCart,
    dismissNotice: dismissCartNotice,
    dismissChanged: dismissCartChanged,
  };
}

/** Test seam. */
export function resetCartForTests(): void {
  state = INITIAL;
  hydrated = false;
  merging = false;
  mergeFailed = false;
  loading = null;
  cachedFor = null;
  for (const listener of listeners) listener();
}
