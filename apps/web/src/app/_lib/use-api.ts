"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiError, api, describeError } from "./api";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string; error: unknown }
  | { status: "ready"; data: T };

/** GET a private or public API path from the browser; `reload()` tries again. `path` null waits. */
export function useApiGet<T>(path: string | null): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const loadedPath = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-runs the request on demand
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    // a reload of the same path keeps showing what is there until the new answer arrives
    const samePath = loadedPath.current === path;
    setState((prev) => (samePath && prev.status === "ready" ? prev : { status: "loading" }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        loadedPath.current = path;
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: describeError(error), error });
      });
    return () => controller.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error ? String((error as ApiError).code) : null;
}
