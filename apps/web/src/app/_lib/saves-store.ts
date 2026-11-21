import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import type { SavedPage } from "./selling";
import { sellingErrorText } from "./selling";

/**
 * Which products the signed-in person has saved, kept in memory for the page's lifetime so every
 * heart on a page agrees. Loaded in the browser after sign-in is known; nothing is stored in
 * browser storage. Changes are optimistic and roll back when the server refuses.
 */
export interface SavesState {
  status: "idle" | "loading" | "ready" | "error";
  ids: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();
let state: SavesState = { status: "idle", ids: EMPTY };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const SERVER: SavesState = { status: "idle", ids: EMPTY };
const MAX_PAGES = 20;
/** Changes made while a load was in flight; they win over the (older) list the load brings back. */
const overrides = new Map<string, boolean>();

function set(next: SavesState): void {
  state = next;
  for (const listener of listeners) listener();
}

const key = (productId: string) => productId.toLowerCase();

/** Reads every saved product id (paged). Safe to call repeatedly. */
export function loadSaves(force = false): Promise<void> {
  if (!force && (state.status === "ready" || inflight)) return inflight ?? Promise.resolve();
  inflight = (async () => {
    overrides.clear();
    set({ status: "loading", ids: state.ids });
    try {
      const ids = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: SavedPage = await api<SavedPage>(
          `/api/v1/saves?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        );
        for (const item of result.items) ids.add(key(item.productId));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      for (const [id, saved] of overrides) {
        if (saved) ids.add(id);
        else ids.delete(id);
      }
      set({ status: "ready", ids });
    } catch {
      set({ status: "error", ids: state.ids });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Forget everything (after sign-out). */
export function resetSaves(): void {
  set({ status: "idle", ids: EMPTY });
}

export type ToggleResult = { ok: true; saved: boolean } | { ok: false; code: string | null; message: string };

/** Save or unsave one product now; the heart changes at once and is put back if the server says no. */
export async function toggleSaved(productId: string): Promise<ToggleResult> {
  const id = key(productId);
  const wasSaved = state.ids.has(id);
  const optimistic = new Set(state.ids);
  if (wasSaved) optimistic.delete(id);
  else optimistic.add(id);
  set({ ...state, ids: optimistic });
  try {
    if (wasSaved) await api(`/api/v1/saves/${id}`, { method: "DELETE" });
    else await api("/api/v1/saves", { method: "POST", body: { productId: id } });
    if (inflight) overrides.set(id, !wasSaved);
    return { ok: true, saved: !wasSaved };
  } catch (error) {
    const rolledBack = new Set(state.ids);
    if (wasSaved) rolledBack.add(id);
    else rolledBack.delete(id);
    set({ ...state, ids: rolledBack });
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : null;
    return { ok: false, code, message: sellingErrorText(error) };
  }
}

/** Mark a product as saved without a request (the server already did it, e.g. a relief claim). */
export function markSaved(productId: string): void {
  const next = new Set(state.ids);
  next.add(key(productId));
  set({ ...state, ids: next });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The saved ids; `enabled` is true for a signed-in person, which starts the load. */
export function useSaves(enabled: boolean): SavesState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER,
  );
  useEffect(() => {
    if (enabled) void loadSaves();
    else if (state.status !== "idle") resetSaves();
  }, [enabled]);
  return snapshot;
}
