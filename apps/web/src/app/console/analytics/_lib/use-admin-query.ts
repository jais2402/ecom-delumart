"use client";

import { useCallback, useEffect, useState } from "react";
import { isDenied } from "../../../_components/console/ConsoleFrame";
import { api } from "../../../_lib/api";
import { isForbidden, studioErrorText } from "../../../_lib/studio";

export type QueryState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; message: string }
  | { status: "denied" };

/**
 * GET one admin analytics path and keep the answer for the current path only: a slow answer for an
 * old range is dropped. 403 (or no session) is "denied", anything else an error with a retry.
 */
export function useAdminQuery<T>(path: string): [QueryState<T>, () => void] {
  const [state, setState] = useState<QueryState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the request on retry
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isDenied(error) || isForbidden(error)) setState({ status: "denied" });
        else setState({ status: "error", message: studioErrorText(error) });
      },
    );
    return () => controller.abort();
  }, [path, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}
