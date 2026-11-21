"use client";

import { Alert, Badge, DecisionForm, EmptyState, Heading, Price, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../_lib/api";
import { type ReportCase, reasonLabel } from "../../_lib/merchant";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import { studioErrorText } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";

type Target = {
  productId?: string;
  status?: string;
  name?: string | null;
  pricePaise?: string | null;
  store?: { handle: string; displayName: string };
  handle?: string;
  displayName?: string;
  description?: string;
};

/** /console/reports: open report cases, oldest first. Reporters are only numbers. Non-admins see "Not available". */
export function ReportsScreen() {
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [cases, setCases] = useState<ReportCase[]>([]);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all: ReportCase[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: ReportCase[]; nextCursor: string | null } = await api(
          `/api/v1/admin/reports?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setCases(all);
      setAccess("allowed");
    } catch (error) {
      if (isDenied(error)) setAccess("denied");
      else {
        setMessage(studioErrorText(error));
        setAccess("error");
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (access !== "allowed")
    return <ConsoleGate access={access} message={message} onRetry={() => void load()} />;

  return (
    <ConsoleFrame current="/console/reports">
      <div className="flex flex-col gap-6">
        <PageHeading>Reports</PageHeading>
        <span role="status" aria-live="polite" className="sr-only">
          {notice ?? ""}
        </span>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <section aria-labelledby="cases-heading" className="flex flex-col gap-3">
          <Heading level={2} size="sm" id="cases-heading">
            Open cases ({cases.length})
          </Heading>
          <Text size="sm" muted>
            Oldest first. Reporters are shown as numbers; their identities are not available here.
          </Text>
          {cases.length === 0 ? (
            <EmptyState
              title="No open cases"
              description="Reports from shoppers appear here."
              headingLevel={3}
            />
          ) : (
            <ul aria-label="Open report cases" className="flex flex-col gap-4">
              {cases.map((c) => (
                <li key={c.id}>
                  <CaseCard
                    c={c}
                    onResolved={(text) => {
                      setNotice(text);
                      void load();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsoleFrame>
  );
}

function CaseCard({ c, onResolved }: { c: ReportCase; onResolved: (text: string) => void }) {
  const target = (c.target ?? {}) as Target;
  const name = c.targetType === "PRODUCT" ? (target.name ?? "Product") : (target.displayName ?? "Shop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(outcome: "UPHELD" | "DISMISSED", reason: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/admin/reports/${c.id}/resolve`, { method: "POST", body: { outcome, reason } });
      onResolved(`${outcome === "UPHELD" ? "Upheld" : "Dismissed"}: ${name}.`);
    } catch (e) {
      setError(studioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-label={`Report case: ${name}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} size="sm" className="break-words">
          {name}
        </Heading>
        <Badge tone="info">{c.targetType === "PRODUCT" ? "Product" : "Shop"}</Badge>
        {c.autoHidden ? <Badge tone="danger">Auto-hidden</Badge> : null}
      </div>
      <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="text-fg-muted">Opened</dt>
        <dd>{formatWhen(c.openedAt)}</dd>
        {c.targetType === "PRODUCT" ? (
          <>
            <dt className="text-fg-muted">Shop</dt>
            <dd className="break-words">
              {target.store ? `${target.store.displayName} (/store/${target.store.handle})` : "Unknown"}
            </dd>
            <dt className="text-fg-muted">Listing status</dt>
            <dd>{(target.status ?? "unknown").toLowerCase().replaceAll("_", " ")}</dd>
            {target.pricePaise ? (
              <>
                <dt className="text-fg-muted">Price</dt>
                <dd>
                  <Price amountPaise={parsePaise(target.pricePaise)} display="exact" className="text-sm" />
                </dd>
              </>
            ) : null}
          </>
        ) : (
          <>
            <dt className="text-fg-muted">Handle</dt>
            <dd>/store/{target.handle}</dd>
            {target.description ? (
              <>
                <dt className="text-fg-muted">About</dt>
                <dd className="break-words">{target.description}</dd>
              </>
            ) : null}
          </>
        )}
        <dt className="text-fg-muted">Reporters</dt>
        <dd>
          {c.reporterCount} ({c.qualifyingReporterCount} counting towards the automatic hide)
        </dd>
        <dt className="text-fg-muted">Reasons</dt>
        <dd>
          {Object.entries(c.reasonCounts)
            .map(([r, n]) => `${reasonLabel(r)} (${n})`)
            .join(", ")}
        </dd>
      </dl>
      <div>
        <p className="text-sm font-bold">Reports</p>
        <ol aria-label="Reports in this case" className="mt-1 flex flex-col gap-2">
          {c.reports.map((r) => (
            <li key={r.reporter} className="rounded-md border border-border p-2 text-sm">
              <p className="font-medium">
                Reporter {r.reporter}: {reasonLabel(r.reason)}
              </p>
              <p className="whitespace-pre-wrap break-words text-fg-muted">
                {r.detail ?? "No detail given."}
              </p>
              {r.detailFlags.length > 0 ? (
                <Badge tone="warning">Detail flagged: {r.detailFlags.join(", ").toLowerCase()}</Badge>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
      <DecisionForm
        label={`report case for ${name}`}
        hint="Recorded with the decision."
        options={[
          { value: "UPHELD", label: "Uphold", variant: "danger" },
          { value: "DISMISSED", label: "Dismiss", variant: "secondary" },
        ]}
        busy={busy}
        error={error}
        onDecide={(outcome, reason) => void resolve(outcome, reason)}
      />
    </article>
  );
}
