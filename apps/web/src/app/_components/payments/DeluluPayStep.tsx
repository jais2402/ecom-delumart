"use client";

import { Alert, BankChallenge, Button, FictionLabel, Heading, Text } from "@delulu/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, describeError } from "../../_lib/api";
import { clock, type InboxMessage, secondsUntil, wrongCodeText } from "../../_lib/payments";
import { PAYMENT_UI_CONFIG } from "../../_lib/payments-config";
import { BankInbox, useBankInbox } from "./BankInbox";

interface Props {
  sessionId: string;
  attemptId: string;
  /** NET_BANKING: a bank page, then a six-digit code from the inbox. DELULUPAY_ID: an approval request. */
  method: "NET_BANKING" | "DELULUPAY_ID";
  totalPaise: bigint;
  /** The payer's bank alias (net banking page). Never a number. */
  accountAlias: string;
  /** The step passed: the checkout now pays. */
  onAuthenticated: () => void;
  /** The payment ended (declined, locked, expired, unavailable ...): the checkout shows why. */
  onEnded: (err: ApiError) => void;
  /** The player cancelled; the attempt is recorded as "cancelled by you". */
  onCancelled: () => void;
}

interface Issued {
  at: number;
  resendAfterSeconds: number;
  expiresAt: string;
}

/**
 * The bank step of a net banking or DeluluPay ID payment (PRD R4.2, R4.4). The server generates the
 * code and sends it to the in-app bank inbox only; this page shows the inbox beside the code field so the
 * player can read it there, as they would open a bank app. Three tries, three minutes, resend after 30
 * seconds. There is no field for a card number, expiry, CVV, UPI PIN or password.
 */
export function DeluluPayStep({
  sessionId,
  attemptId,
  method,
  totalPaise,
  accountAlias,
  onAuthenticated,
  onEnded,
  onCancelled,
}: Props) {
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [liveNote, setLiveNote] = useState("");
  const started = useRef(false);
  const inbox = useBankInbox(true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PAYMENT_UI_CONFIG.tickMs);
    return () => clearInterval(timer);
  }, []);

  async function issue() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ resendAfterSeconds: number; expiresAt: string }>(
        `/api/v1/checkout-sessions/${sessionId}/challenge`,
        { method: "POST" },
      );
      setIssued({ at: Date.now(), resendAfterSeconds: res.resendAfterSeconds, expiresAt: res.expiresAt });
      setLiveNote(
        method === "NET_BANKING"
          ? "A code was sent to your bank inbox."
          : "An approval request was sent to your bank inbox.",
      );
      inbox.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        setError(err.message);
      } else if (err instanceof ApiError) {
        onEnded(err);
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  // an approval request is sent as soon as the step opens; a net banking code when the player asks for it
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per step
  useEffect(() => {
    if (method === "DELULUPAY_ID" && !started.current) {
      started.current = true;
      void issue();
    }
  }, [method]);

  async function answer(body: { code: string } | { decision: "APPROVE" | "DECLINE" }) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ status: string; retryAfterSeconds?: number }>(
        `/api/v1/checkout-sessions/${sessionId}/challenge/verify`,
        { method: "POST", body },
      );
      if (res.status === "AUTHENTICATED") {
        onAuthenticated();
        return;
      }
      if (res.status === "DECLINED") {
        onEnded(
          new ApiError("CANCELLED", "You declined this payment. No fictional money moved.", false, 200),
        );
        return;
      }
      // WAITING: a slow bank
      setError(
        `Delulu Bank is slow to answer. Try again in ${res.retryAfterSeconds ?? PAYMENT_UI_CONFIG.slowBankRetrySeconds} seconds.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "CHALLENGE_FAILED") {
        setError(wrongCodeText(err));
      } else if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        setError(err.message);
      } else if (err instanceof ApiError) {
        onEnded(err);
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    try {
      await api(`/api/v1/attempts/${attemptId}/cancel`, { method: "POST" });
    } catch {
      // already ended: the checkout resets either way
    }
    onCancelled();
  }

  const resendIn = issued ? secondsUntil(issued.at + issued.resendAfterSeconds * 1000, now) : 0;
  const codeLeft = issued ? secondsUntil(issued.expiresAt, now) : 0;
  const decide = (message: InboxMessage, decision: "APPROVE" | "DECLINE") => {
    if (message.attemptId === attemptId) void answer({ decision });
  };

  return (
    <div className="flex flex-col gap-4">
      <p role="status" aria-live="polite" className="sr-only">
        {liveNote}
      </p>
      {method === "NET_BANKING" ? (
        <>
          <BankChallenge
            amountPaise={totalPaise}
            cardAlias={accountAlias}
            sourceLabel="Account"
            method="code"
            headingLevel={2}
            {...(error ? { error } : {})}
            loading={busy && issued !== null}
            onPay={(code) => void answer({ code })}
            onCancel={() => void cancel()}
          />
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface p-4">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || (issued !== null && resendIn > 0)}
              onClick={() => void issue()}
            >
              {issued === null ? "Send me a code" : "Send a new code"}
            </Button>
            <Text size="sm" muted>
              {issued === null
                ? "The code appears in your bank inbox below."
                : resendIn > 0
                  ? `You can ask for a new code in ${resendIn} seconds.`
                  : codeLeft > 0
                    ? `The code works for ${clock(codeLeft)} more.`
                    : "The code has expired. Ask for a new one."}
            </Text>
          </div>
        </>
      ) : (
        <section
          aria-labelledby="approval-title"
          className="flex flex-col gap-3 rounded-lg bg-surface p-4 md:p-6"
        >
          <Heading level={2} size="md" id="approval-title">
            Delulu Bank approval request
          </Heading>
          <Text>
            Delulu Bank sent an approval request to your bank inbox. Approve it below to pay, or decline to
            stop.
          </Text>
          {error ? (
            <Alert tone="warning" title="Not yet">
              {error}
            </Alert>
          ) : null}
          {issued !== null && codeLeft > 0 ? (
            <Text size="sm" muted>
              The request is open for {clock(codeLeft)} more.
            </Text>
          ) : null}
          <FictionLabel>In-game payment · fictional money</FictionLabel>
          <div>
            <Button type="button" variant="secondary" onClick={() => void cancel()}>
              Cancel payment
            </Button>
          </div>
        </section>
      )}
      <BankInbox
        messages={
          inbox.messages === null
            ? null
            : inbox.messages.filter((m) => m.attemptId === attemptId || m.status === "OPEN")
        }
        error={inbox.error}
        {...(method === "DELULUPAY_ID" ? { onDecide: decide } : {})}
        busy={busy}
        now={now}
      />
    </div>
  );
}
