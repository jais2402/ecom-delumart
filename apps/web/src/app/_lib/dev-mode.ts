import { useSyncExternalStore } from "react";

/**
 * True once the server has answered with a development-only field (the phone step returns a code
 * only when AUTH_PROVIDER is "dev"). The API has no other way to say which provider is active.
 */
let dev = false;
const listeners = new Set<() => void>();

export function markDevProvider(): void {
  if (dev) return;
  dev = true;
  for (const listener of listeners) listener();
}

export function useDevProvider(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dev,
    () => false,
  );
}
