"use client";

import { configKeySpec, formatCountdown } from "@delulu/core";
import { Alert, Badge, Heading, Text } from "@delulu/ui";
import { useCallback, useEffect, useState } from "react";
import { type ConfigOverviewResponse, valueText } from "../../_lib/admin-actions";
import { api } from "../../_lib/api";
import { studioErrorText } from "../../_lib/studio";
import { PageHeading } from "../PageHeading";
import { ConfigChangeForm } from "./ConfigChangeForm";
import { type ConsoleAccess, ConsoleFrame, ConsoleGate, isDenied } from "./ConsoleFrame";

/**
 * /console/configuration: the current value of each setting the Super Admin may change, and a form
 * to propose a change. A change goes through the delay (it is queued, can be cancelled, and applies
 * only to orders placed afterwards); it never takes effect from this page.
 */
export function ConfigurationScreen() {
  const [access, setAccess] = useState<ConsoleAccess>("checking");
  const [data, setData] = useState<ConfigOverviewResponse | null>(null);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ConfigOverviewResponse>("/api/v1/admin/config"));
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

  return (
    <ConsoleFrame current="/console/configuration">
      <div className="flex flex-col gap-6">
        <PageHeading>Configuration</PageHeading>
        <Text size="sm" muted>
          A change you propose here waits {delayText} before it is applied, and you can cancel it from{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/console/actions">
            Pending actions
          </a>{" "}
          until then. It applies only to orders placed after it takes effect: orders already placed keep the
          settings they were placed under. Once applied, it is announced on the storefront. Configuration
          version in use now: {data.version}.
        </Text>
        <span role="status" aria-live="polite" className="sr-only">
          {notice ?? ""}
        </span>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ul aria-label="Settings" className="flex flex-col gap-4">
          {data.keys.map((k) => {
            const spec = configKeySpec(k.key);
            if (spec === undefined) return null;
            return (
              <li key={k.key}>
                <article
                  aria-label={spec.label}
                  className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Heading level={2} size="sm">
                      {spec.label}
                    </Heading>
                    {k.pendingActionId ? <Badge tone="info">Change waiting</Badge> : null}
                  </div>
                  <Text size="sm" muted>
                    {spec.help}
                  </Text>
                  <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-fg-muted">Current</dt>
                      <dd className="font-bold">{valueText(spec, k.current)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Default</dt>
                      <dd>{valueText(spec, k.default)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Allowed</dt>
                      <dd>
                        {valueText(spec, k.min)} to {valueText(spec, k.max)}
                      </dd>
                    </div>
                  </dl>
                  {k.pendingActionId ? (
                    <Alert tone="info">
                      A change to this setting is already waiting. Cancel it in{" "}
                      <a className="inline-flex min-h-touch items-center underline" href="/console/actions">
                        Pending actions
                      </a>{" "}
                      to propose another.
                    </Alert>
                  ) : (
                    <ConfigChangeForm
                      spec={spec}
                      delayText={delayText}
                      onProposed={(text) => {
                        setNotice(text);
                        void load();
                      }}
                    />
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </ConsoleFrame>
  );
}
