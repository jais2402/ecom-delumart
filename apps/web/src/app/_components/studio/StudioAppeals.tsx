"use client";

import { Alert, AppealForm, Badge, Heading, ListingStatus, type ListingStatusValue, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../_lib/api";
import { type AppealRow, merchantErrorText } from "../../_lib/merchant";
import { formatWhen } from "../../_lib/orders";
import type { ListingDetail, ListingPage } from "../../_lib/studio";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PortalTitle } from "./PortalTitle";

const APPEAL_STATUS: Record<
  AppealRow["status"],
  { label: string; tone: "info" | "success" | "danger"; text: string }
> = {
  OPEN: { label: "Waiting", tone: "info", text: "A person will read your appeal." },
  UPHELD: { label: "Upheld", tone: "success", text: "The decision was reversed." },
  DENIED: { label: "Denied", tone: "danger", text: "The decision stands." },
};

type Candidate = {
  id: string;
  name: string;
  status: ListingStatusValue;
  reason: string | null;
  appealable: boolean;
};

/** /studio/appeals: appeals sent so far, and a form for each rejected or hidden listing that can still be appealed. */
export function StudioAppeals() {
  const appeals = useApiGet<{ items: AppealRow[] }>("/api/v1/studio/appeals");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [justSent, setJustSent] = useState<Record<string, AppealRow>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick reloads after an appeal is sent
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await api<ListingPage>("/api/v1/studio/products?limit=50");
      const flagged = page.items.filter((l) => l.status === "REJECTED" || l.status === "HIDDEN");
      const details = await Promise.all(
        flagged.map((l) => api<{ product: ListingDetail }>(`/api/v1/studio/products/${l.id}`)),
      );
      if (cancelled) return;
      setCandidates(
        details.map(({ product: d }) => ({
          id: d.id,
          name: (d.live ?? d.current ?? d.pending?.version)?.name ?? "Untitled listing",
          status: d.status,
          reason: d.moderationReason ?? d.lastDecision?.reason ?? null,
          appealable: d.appealable,
        })),
      );
    })().catch((e: unknown) => {
      if (!cancelled) setFailed(merchantErrorText(e));
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const sent = useCallback(
    (id: string, appeal: AppealRow) => {
      setJustSent((m) => ({ ...m, [id]: appeal }));
      appeals.reload();
      setTick((n) => n + 1);
    },
    [appeals],
  );

  return (
    <div className="flex flex-col gap-6">
      <PortalTitle>Appeals</PortalTitle>
      <Text muted>
        If a listing was rejected or hidden and you think that was a mistake, you can appeal once per
        decision.
      </Text>
      {failed ? (
        <ErrorBlock
          message={failed}
          onRetry={() => {
            setFailed(null);
            setTick((n) => n + 1);
          }}
        />
      ) : null}
      {candidates === null && !failed ? <LoadingBlock rows={2} label="Loading your listings" /> : null}
      {candidates ? (
        <section aria-labelledby="ap-can" className="flex flex-col gap-3">
          <Heading level={2} size="sm" id="ap-can">
            Listings you can appeal
          </Heading>
          {candidates.filter((c) => c.appealable || justSent[c.id]).length === 0 ? (
            <Text muted>None of your listings can be appealed right now.</Text>
          ) : null}
          {candidates
            .filter((c) => c.appealable || justSent[c.id])
            .map((c) => (
              <AppealCard
                key={c.id}
                candidate={c}
                sent={justSent[c.id] ?? null}
                onSent={(a) => sent(c.id, a)}
              />
            ))}
        </section>
      ) : null}

      <section aria-labelledby="ap-list" className="flex flex-col gap-3">
        <Heading level={2} size="sm" id="ap-list">
          Your appeals
        </Heading>
        {appeals.status === "loading" ? <LoadingBlock rows={2} label="Loading your appeals" /> : null}
        {appeals.status === "error" ? (
          <ErrorBlock message={appeals.message} onRetry={appeals.reload} />
        ) : null}
        {appeals.status === "ready" && appeals.data.items.length === 0 ? (
          <Text muted>You have not sent any appeals.</Text>
        ) : null}
        {appeals.status === "ready" && appeals.data.items.length > 0 ? (
          <ul aria-label="Appeals" className="flex flex-col gap-3">
            {appeals.data.items.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Heading level={3} size="sm" className="break-words">
                    {a.productName ?? "Listing"}
                  </Heading>
                  <Badge tone={APPEAL_STATUS[a.status].tone}>{APPEAL_STATUS[a.status].label}</Badge>
                </div>
                <Text size="sm" muted>
                  Sent {formatWhen(a.createdAt)}. {APPEAL_STATUS[a.status].text}
                </Text>
                <Text size="sm" className="whitespace-pre-wrap break-words">
                  {a.statement}
                </Text>
                {a.decisionReason ? (
                  <Text size="sm">
                    <strong>Reason given:</strong> {a.decisionReason}
                  </Text>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function AppealCard({
  candidate,
  sent,
  onSent,
}: {
  candidate: Candidate;
  sent: AppealRow | null;
  onSent: (appeal: AppealRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(statement: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ appeal: AppealRow }>(`/api/v1/studio/products/${candidate.id}/appeal`, {
        method: "POST",
        body: { statement },
      });
      onSent(result.appeal);
    } catch (e) {
      setError(merchantErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-label={`Appeal: ${candidate.name}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={3} size="sm" className="break-words">
        {candidate.name}
      </Heading>
      <ListingStatus status={candidate.status} moderationReason={candidate.reason} />
      {sent ? (
        <Alert tone="success" title="Appeal sent">
          Status: {APPEAL_STATUS[sent.status].label}. {APPEAL_STATUS[sent.status].text}
        </Alert>
      ) : (
        <AppealForm
          aria-label={`Appeal ${candidate.name}`}
          onSubmit={(s) => void send(s)}
          busy={busy}
          error={error}
        />
      )}
    </article>
  );
}
