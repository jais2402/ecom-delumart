"use client";

import { Badge, Button, Heading, Price, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import { formatWhen } from "../../_lib/orders";
import type { InboxMessage } from "../../_lib/payments";
import { PAYMENT_UI_CONFIG } from "../../_lib/payments-config";

/**
 * The player's in-app Delulu Bank inbox (PRD R4.4): the only place a one-time code is ever shown.
 * Read from the server (private, no-store) and kept in memory only; nothing is written to storage, the
 * URL or the console. No SMS, email or push message carries a code.
 */
export function useBankInbox(active: boolean, intervalMs: number = PAYMENT_UI_CONFIG.inboxPollMs) {
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the inbox on demand
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const read = () =>
      api<{ items: InboxMessage[] }>("/api/v1/bank/inbox")
        .then((res) => {
          if (cancelled) return;
          setMessages(res.items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(describeError(err));
        });
    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, intervalMs, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { messages, error, reload };
}

const CLOSED_TEXT: Record<InboxMessage["status"], string> = {
  OPEN: "",
  USED: "Used.",
  EXPIRED: "Expired.",
  CLOSED: "Closed.",
};

export interface BankInboxProps {
  messages: InboxMessage[] | null;
  error: string | null;
  /** Approve or decline an open approval request (checkout and the inbox page). */
  onDecide?: (message: InboxMessage, decision: "APPROVE" | "DECLINE") => void;
  busy?: boolean;
  /** Heading level, so the checkout (h2 steps) and the account page (h1 page) both stay in order. */
  headingLevel?: 2 | 3;
  now?: number;
}

export function BankInbox({
  messages,
  error,
  onDecide,
  busy,
  headingLevel = 2,
  now = Date.now(),
}: BankInboxProps) {
  return (
    <section
      aria-labelledby="bank-inbox-title"
      className="flex flex-col gap-3 rounded-lg bg-surface-raised p-4"
    >
      <Heading level={headingLevel} size="md" id="bank-inbox-title">
        Bank inbox
      </Heading>
      <Text size="sm" muted>
        Messages from Delulu Bank appear here and nowhere else. Nothing is sent by text, email or push.
      </Text>
      {error ? (
        <Text size="sm" className="text-danger">
          {error}
        </Text>
      ) : null}
      {messages === null && !error ? <Text size="sm">Checking your inbox…</Text> : null}
      {messages !== null && messages.length === 0 ? <Text size="sm">No messages yet.</Text> : null}
      {messages !== null && messages.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Messages">
          {messages.map((m) => {
            const open = m.status === "OPEN";
            const slow = open && m.availableAt !== null && Date.parse(m.availableAt) > now;
            return (
              <li key={m.id} className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-fg">
                    Delulu Bank · {m.kind === "CODE" ? "SecureCheck code" : "Approval request"}
                  </span>
                  <Badge tone={open ? "warning" : "neutral"}>
                    {open ? "Open" : CLOSED_TEXT[m.status].replace(".", "")}
                  </Badge>
                </div>
                {m.kind === "CODE" ? (
                  open && m.code ? (
                    <p className="text-base text-fg">
                      Your SecureCheck code is{" "}
                      <strong className="font-mono text-lg tracking-widest" data-testid="inbox-code">
                        {m.code}
                      </strong>
                      . It works once, for a few minutes, on this payment only.
                    </p>
                  ) : (
                    <Text size="sm" muted>
                      A code was sent for payment {m.reference}. {CLOSED_TEXT[m.status]}
                    </Text>
                  )
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-base text-fg">
                      DeluluMart asks to take{" "}
                      <Price amountPaise={parsePaise(m.amountPaise)} display="exact" /> from your bank
                      balance. Payment {m.reference}.
                    </p>
                    {open ? (
                      slow ? (
                        <Text size="sm" muted>
                          Delulu Bank is slow to answer. This request will be ready in a moment.
                        </Text>
                      ) : onDecide ? (
                        <div className="flex flex-wrap gap-2">
                          <Button variant="ctaStrong" disabled={busy} onClick={() => onDecide(m, "APPROVE")}>
                            Approve
                          </Button>
                          <Button variant="secondary" disabled={busy} onClick={() => onDecide(m, "DECLINE")}>
                            Decline
                          </Button>
                        </div>
                      ) : (
                        <Text size="sm" muted>
                          Answer it on the checkout page.
                        </Text>
                      )
                    ) : (
                      <Text size="sm" muted>
                        {CLOSED_TEXT[m.status]}
                      </Text>
                    )}
                  </div>
                )}
                <Text size="sm" muted>
                  {formatWhen(m.createdAt)}
                </Text>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Text size="sm" muted>
        In-game payment · fictional money
      </Text>
    </section>
  );
}
