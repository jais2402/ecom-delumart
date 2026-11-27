"use client";

import { formatCountdown } from "@delulu/core";
import { Alert, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import type { AdminActionsResponse } from "../../_lib/admin-actions";
import { api } from "../../_lib/api";
import { type AdminMethodsResponse, proposedSettings } from "../../_lib/payment-methods-admin";
import { studioErrorText } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";
import { PaymentMethodCard } from "./PaymentMethodCard";

/**
 * /console/payment-methods: each payment method's current settings, the change waiting for each
 * (read from the open delayed actions), and a form to propose one more. A change never takes
 * effect from this page: it joins the 24-hour, cancellable queue (docs/decisions.md #16, #17).
 */
export function PaymentMethodsScreen() {
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [data, setData] = useState<AdminMethodsResponse | null>(null);
  const [open, setOpen] = useState<AdminActionsResponse | null>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [methods, actions] = await Promise.all([
        api<AdminMethodsResponse>("/api/v1/admin/payment-methods"),
        api<AdminActionsResponse>("/api/v1/admin/actions?scope=OPEN&page=1"),
      ]);
      setData(methods);
      setOpen(actions);
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

  if (access !== "allowed" || data === null)
    return (
      <ConsoleGate
        access={access === "allowed" ? "checking" : access}
        message={message}
        onRetry={() => void load()}
      />
    );

  const delayText = formatCountdown(data.delaySeconds);
  const waiting = new Map((open?.items ?? []).map((a) => [a.id, a]));

  return (
    <ConsoleFrame current="/console/payment-methods">
      <div className="flex flex-col gap-6">
        <PageHeading>Payment methods</PageHeading>
        <Text size="sm" muted>
          Which methods customers can pay with, in what order, with what limits, and when a method is in
          maintenance. A change you propose waits {delayText} before it is applied, and you can cancel it from{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/console/actions">
            Pending actions
          </a>{" "}
          until then. It is checked again when it runs, so at least one method always stays usable. The
          emergency switches are separate and are not changed here.
        </Text>
        <span role="status" aria-live="polite" className="sr-only">
          {notice ?? ""}
        </span>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ul aria-label="Payment methods" className="flex flex-col gap-4">
          {[...data.methods]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((m) => {
              const action = m.pendingActionId ? waiting.get(m.pendingActionId) : undefined;
              return (
                <li key={m.method}>
                  <PaymentMethodCard
                    method={m}
                    proposed={action ? proposedSettings(action.details) : null}
                    delayText={delayText}
                    onProposed={(text) => {
                      setNotice(text);
                      void load();
                    }}
                  />
                </li>
              );
            })}
        </ul>
      </div>
    </ConsoleFrame>
  );
}
