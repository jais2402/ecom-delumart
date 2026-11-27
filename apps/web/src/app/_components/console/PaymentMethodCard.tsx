"use client";

import { Alert, Badge, Heading, Text } from "@delulu/ui";
import {
  type AdminMethod,
  changedSettings,
  type MethodSettings,
  methodLabel,
  type SETTING_LABELS,
  settingRows,
} from "../../_lib/payment-methods-admin";
import { PaymentMethodForm } from "./PaymentMethodForm";

/**
 * One payment method: whether customers can use it now and why, its current settings beside the
 * change that is waiting (if any), and the form to propose another. The kill switch is shown but
 * cannot be changed here.
 */
export function PaymentMethodCard({
  method,
  proposed,
  delayText,
  onProposed,
}: {
  method: AdminMethod;
  /** The waiting change's new settings, when they could be read. */
  proposed: MethodSettings | null;
  delayText: string;
  onProposed: (text: string) => void;
}) {
  const label = methodLabel(method.method);
  const current = settingRows(method);
  const next = proposed ? settingRows(proposed) : null;
  const changed = proposed ? changedSettings(method, proposed) : new Set<keyof typeof SETTING_LABELS>();
  const headingId = `method-${method.method}`;

  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={2} size="sm" id={headingId}>
          {label}
        </Heading>
        <Badge tone={method.available ? "success" : "warning"}>
          {method.available ? "Available now" : "Not available now"}
        </Badge>
        {!method.enabled ? <Badge tone="neutral">Switched off</Badge> : null}
        {!method.switchOn ? <Badge tone="danger">Stopped by the emergency switch</Badge> : null}
        {method.inMaintenance ? <Badge tone="warning">In maintenance</Badge> : null}
        {method.pendingActionId ? <Badge tone="info">Change waiting</Badge> : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-left text-sm">
          <caption className="sr-only">
            {proposed
              ? `${label}: current settings and the change that is waiting`
              : `${label}: current settings`}
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2 pr-3 font-medium text-fg-muted">
                Setting
              </th>
              <th scope="col" className="py-2 pr-3 font-medium text-fg-muted">
                Current
              </th>
              {next ? (
                <th scope="col" className="py-2 font-medium text-fg-muted">
                  Proposed
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {current.map((row, index) => {
              const isChanged = changed.has(row.key);
              return (
                <tr key={row.key} className="border-b border-border last:border-0">
                  <th scope="row" className="py-2 pr-3 font-normal text-fg-muted">
                    {row.label}
                  </th>
                  <td className="py-2 pr-3 font-bold">{row.value}</td>
                  {next ? (
                    <td className="py-2">
                      <span className={isChanged ? "font-bold text-action" : "text-fg-muted"}>
                        {next[index]?.value}
                      </span>
                      {isChanged ? <span className="sr-only"> (changed)</span> : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {method.pendingActionId ? (
        <Alert tone="info">
          A change to this method is already waiting
          {proposed ? "" : " (its details could not be shown here)"}. Cancel it in{" "}
          <a className="inline-flex min-h-touch items-center underline" href="/console/actions">
            Pending actions
          </a>{" "}
          to propose another.
        </Alert>
      ) : (
        <>
          <Text size="sm" muted>
            A change waits {delayText} before it applies and can be cancelled until then. The server refuses
            any change that would leave customers with no usable payment method.
          </Text>
          <PaymentMethodForm method={method} delayText={delayText} onProposed={onProposed} />
        </>
      )}
    </article>
  );
}
