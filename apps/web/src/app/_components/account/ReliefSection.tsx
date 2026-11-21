"use client";

import { type ReliefCandidate, ReliefPanel, Text } from "@delulu/ui";
import { useMemo, useState } from "react";
import { api, type ProductResponse } from "../../_lib/api";
import { parsePaise, parsePaiseOrNull } from "../../_lib/money";
import { markSaved, useSaves } from "../../_lib/saves-store";
import { errorCodeOf, type ReliefResponse, sellingErrorText } from "../../_lib/selling";
import { refreshSession } from "../../_lib/session-store";
import { useApiGet } from "../../_lib/use-api";

const SUGGESTIONS = 4;

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "the next UTC midnight";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

interface Claim extends ReliefResponse {
  productId: string;
}

/**
 * The relief offer for a low balance. On the overview it shows only when a claim is possible; on
 * the wallet page it also explains, in one line, why not when the daily or lifetime limit is reached.
 */
export function ReliefSection({
  variant,
  onClaimed,
}: {
  variant: "overview" | "wallet";
  /** Called after a successful claim so the page can reload its balance. */
  onClaimed?: () => void;
}) {
  const status = useApiGet<ReliefResponse>("/api/v1/relief");
  const eligible = status.status === "ready" && status.data.eligible;
  const catalog = useApiGet<{ items: ProductResponse[] }>(eligible ? "/api/v1/catalog?limit=50" : null);
  const saves = useSaves(eligible);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<Claim | null>(null);

  const candidates = useMemo<ReliefCandidate[]>(() => {
    if (catalog.status !== "ready" || saves.status !== "ready") return [];
    return catalog.data.items
      .filter((p) => p.available && !saves.ids.has(p.id.toLowerCase()) && !skipped.has(p.id))
      .slice(0, SUGGESTIONS)
      .map((p) => ({ id: p.id, name: p.name, pricePaise: parsePaise(p.pricePaise) }));
  }, [catalog, saves, skipped]);

  async function claim(productId: string) {
    setBusy(true);
    setError(undefined);
    try {
      const done = await api<Claim>("/api/v1/relief/claim", { method: "POST", body: { productId } });
      markSaved(productId);
      setResult(done);
      void refreshSession();
      onClaimed?.();
    } catch (err) {
      if (errorCodeOf(err) === "CONFLICT" || errorCodeOf(err) === "PRODUCT_UNAVAILABLE") {
        setSkipped((current) => new Set(current).add(productId));
      }
      setError(sellingErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.status !== "ready") return null;
  const data = status.data;

  if (result) {
    return (
      <ReliefPanel
        grantPaise={parsePaise(data.grantPaise)}
        claimsRemaining={result.claimsRemaining}
        claimsMax={result.claimsMax}
        candidates={[]}
        onClaim={() => {}}
        result={{
          balancePaise: parsePaiseOrNull(result.balancePaise) ?? 0n,
          nextResetAt: result.nextResetAt,
        }}
      />
    );
  }

  if (data.eligible) {
    if (catalog.status === "loading" || saves.status === "loading" || saves.status === "idle") return null;
    return (
      <ReliefPanel
        grantPaise={parsePaise(data.grantPaise)}
        claimsRemaining={data.claimsRemaining}
        claimsMax={data.claimsMax}
        candidates={candidates}
        loading={busy}
        {...(error ? { error } : {})}
        onClaim={(id) => void claim(id)}
      />
    );
  }

  const balance = parsePaiseOrNull(data.balancePaise);
  const low = balance !== null && balance < parsePaise(data.ceilingPaise);
  if (variant === "wallet" && low) {
    if (data.reason === "CLAIMED_TODAY") {
      return (
        <Text size="sm" muted>
          You have already claimed today's relief grant. The next one opens after{" "}
          {localTime(data.nextResetAt)}. The day resets at midnight UTC.
        </Text>
      );
    }
    if (data.reason === "LIFETIME_LIMIT") {
      return (
        <Text size="sm" muted>
          All {data.claimsMax} relief claims have been used, so there is no relief grant to claim.
        </Text>
      );
    }
  }
  return null;
}
