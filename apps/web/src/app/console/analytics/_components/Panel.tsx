"use client";

import { EmptyState, Heading, Text } from "@delulu/ui";
import { type ReactNode, useId } from "react";
import { ErrorBlock, LoadingBlock } from "../../../_components/LoadState";
import type { QueryState } from "../_lib/use-admin-query";

/** One panel of an analytics screen with its own loading, empty and error states. */
export function Panel<T>({
  title,
  hint,
  controls,
  state,
  retry,
  isEmpty,
  children,
}: {
  title: string;
  hint?: ReactNode;
  /** Always shown, in every state (a selector that changes what the panel loads). */
  controls?: ReactNode;
  state: QueryState<T>;
  retry: () => void;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <Heading level={2} size="sm" id={id}>
        {title}
      </Heading>
      {hint ? (
        <Text size="sm" muted>
          {hint}
        </Text>
      ) : null}
      {controls}
      {state.status === "loading" ? (
        <LoadingBlock rows={2} label={`Loading ${title.toLowerCase()}`} />
      ) : state.status === "error" ? (
        <ErrorBlock message={state.message} onRetry={retry} />
      ) : state.status === "ready" ? (
        isEmpty(state.data) ? (
          <EmptyState
            title="No data for this period yet"
            description="Try a longer range, or check back after the next daily update."
            headingLevel={3}
          />
        ) : (
          children(state.data)
        )
      ) : null}
    </section>
  );
}
