"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { useSession } from "./session-store";

/**
 * The seller keys (company ids) the signed-in person blocked, from /api/v1/me/overlay. It is loaded
 * in the browser after the page renders and applied there, so the public HTML is the same for
 * everyone. In memory only.
 */
const EMPTY: ReadonlySet<string> = new Set();
let keys: ReadonlySet<string> = EMPTY;
let loadedFor = false;
let inflight = false;
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>): void {
  keys = next;
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  if (loadedFor || inflight) return;
  inflight = true;
  try {
    const overlay = await api<{ blockedSellerKeys?: string[] }>("/api/v1/me/overlay");
    set(new Set(overlay.blockedSellerKeys ?? []));
    loadedFor = true;
  } catch {
    // the overlay is a convenience: the server refuses purchases from a blocked shop anyway
  } finally {
    inflight = false;
  }
}

/** Record a block or unblock made on this page, so grids update at once. */
export function markBlocked(companyId: string, blocked: boolean): void {
  const next = new Set(keys);
  if (blocked) next.add(companyId);
  else next.delete(companyId);
  set(next);
}

function reset(): void {
  loadedFor = false;
  if (keys.size > 0) set(EMPTY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The set of blocked seller keys; empty for a signed-out visitor. */
export function useBlockedSellerKeys(): ReadonlySet<string> {
  const session = useSession();
  const status = session.status;
  useEffect(() => {
    if (status === "signedIn") void load();
    else if (status === "signedOut") reset();
  }, [status]);
  return useSyncExternalStore(
    subscribe,
    () => keys,
    () => EMPTY,
  );
}

/** Products from blocked shops removed; platform products ("SEED") are never blocked. */
export function withoutBlocked<T extends { sellerKey?: string | undefined }>(
  items: readonly T[],
  blocked: ReadonlySet<string>,
): readonly T[] {
  return blocked.size === 0
    ? items
    : items.filter((p) => p.sellerKey === undefined || !blocked.has(p.sellerKey));
}
