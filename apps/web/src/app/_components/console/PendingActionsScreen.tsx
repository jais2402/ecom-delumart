"use client";

import { formatCountdown, secondsUntil } from "@delulu/core";
import { Alert, Badge, DataTable, DecisionForm, EmptyState, Heading, Pagination, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { actionWords } from "../../_lib/action-words";
import {
  type AdminActionItem,
  type AdminActionsResponse,
  actionErrorText,
  formatWhen,
  stateBadge,
} from "../../_lib/admin-actions";
import { api } from "../../_lib/api";
import { studioErrorText } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";

/** The countdown refreshes this often (the time left is shown to the minute). */
const TICK_MS = 15_000;

/**
 * /console/actions: the Super Admin's delayed actions. Waiting ones show a countdown and can be
 * cancelled with a reason until they run; the history lists what was applied, cancelled or failed.
 * The countdown runs on the database's clock (the offset is taken when the list loads).
 */
export function PendingActionsScreen() {
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [open, setOpen] = useState<AdminActionsResponse | null>(null);
  const [history, setHistory] = useState<AdminActionsResponse | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [o, h] = await Promise.all([
        api<AdminActionsResponse>("/api/v1/admin/actions?scope=OPEN&page=1"),
        api<AdminActionsResponse>(`/api/v1/admin/actions?scope=HISTORY&page=${historyPage}`),
      ]);
      setOpen(o);
      setHistory(h);
      setOffsetMs(Date.parse(o.serverNow) - Date.now());
      setNow(Date.now());
      setAccess("allowed");
    } catch (error) {
      if (isDenied(error)) setAccess("denied");
      else {
        setMessage(studioErrorText(error));
        setAccess("error");
      }
    }
  }, [historyPage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (access !== "allowed" || open === null || history === null)
    return (
      <ConsoleGate
        access={access === "allowed" ? "checking" : access}
        message={message}
        onRetry={() => void load()}
      />
    );

  const serverNow = now + offsetMs;

  return (
    <ConsoleFrame current="/console/actions">
      <div className="flex flex-col gap-6">
        <PageHeading>Pending actions</PageHeading>
        <Text size="sm" muted>
          A sensitive change waits before it is applied, so a stolen sign-in cannot do immediate damage. You
          can cancel a waiting change until it runs. It then applies once, to orders placed afterwards.
        </Text>
        <span role="status" aria-live="polite" className="sr-only">
          {notice ?? ""}
        </span>
        {notice ? <Alert tone="success">{notice}</Alert> : null}

        <section aria-labelledby="waiting-heading" className="flex flex-col gap-4">
          <Heading level={2} size="md" id="waiting-heading">
            Waiting
          </Heading>
          {open.items.length === 0 ? (
            <EmptyState
              title="Nothing is waiting"
              description="Changes you propose, for example on the Configuration page, wait here until they run."
              headingLevel={3}
            />
          ) : (
            <ul aria-label="Waiting actions" className="flex flex-col gap-4">
              {open.items.map((a) => (
                <li key={a.id}>
                  <WaitingCard
                    action={a}
                    serverNow={serverNow}
                    onDone={(text) => {
                      setNotice(text);
                      void load();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="history-heading" className="flex flex-col gap-4">
          <Heading level={2} size="md" id="history-heading">
            History
          </Heading>
          <DataTable
            caption="Delayed actions: applied, cancelled or failed"
            rows={history.items}
            rowKey={(a) => a.id}
            emptyTitle="No history yet"
            emptyDescription="Applied, cancelled and failed changes are listed here."
            columns={[
              { key: "change", header: "Change", cell: (a) => actionWords(a) },
              {
                key: "state",
                header: "Result",
                cell: (a) => {
                  const badge = stateBadge(a.state);
                  return <Badge tone={badge.tone}>{badge.label}</Badge>;
                },
              },
              {
                key: "when",
                header: "When",
                cell: (a) => formatWhen(a.executedAt ?? a.cancelledAt ?? a.proposedAt),
              },
              { key: "why", header: "Reason", cell: (a) => historyNote(a) },
            ]}
          />
          {history.totalPages > 1 ? (
            <Pagination
              page={history.page}
              pageCount={history.totalPages}
              onPageChange={(p) => setHistoryPage(p)}
            />
          ) : null}
        </section>
      </div>
    </ConsoleFrame>
  );
}

function historyNote(a: AdminActionItem): string {
  if (a.state === "CANCELLED") return `Cancelled: ${a.cancelReason ?? "no reason recorded"}`;
  if (a.state === "FAILED") return `Not applied (${a.outcome?.code ?? "error"}). ${a.reason ?? ""}`.trim();
  if (a.state === "EXECUTED" && a.outcome?.changed === false)
    return `Already the value. ${a.reason ?? ""}`.trim();
  return a.reason ?? "";
}

function WaitingCard({
  action,
  serverNow,
  onDone,
}: {
  action: AdminActionItem;
  serverNow: number;
  onDone: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentence = actionWords(action);
  const left = secondsUntil(action.notBefore, serverNow);

  async function cancel(reason: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/admin/actions/${action.id}/cancel`, { method: "POST", body: { reason } });
      onDone(`Cancelled: ${sentence}.`);
    } catch (e) {
      setError(actionErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-label={sentence}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={3} size="sm" className="break-words">
          {sentence}
        </Heading>
        <Badge tone="info">Waiting</Badge>
      </div>
      <Text size="sm">
        {left > 0 ? `Applies in ${formatCountdown(left)}` : "Due now: it runs with the next scheduled job"} (
        {formatWhen(action.notBefore)}).
      </Text>
      {action.reason ? (
        <Text size="sm" muted className="break-words">
          Why: {action.reason}
        </Text>
      ) : null}
      <DecisionForm
        label={sentence}
        hint="It is kept in the audit log."
        options={[{ value: "cancel", label: "Cancel this change", variant: "secondary" }]}
        busy={busy}
        error={error}
        onDecide={(_value, reason) => void cancel(reason)}
      />
    </article>
  );
}
