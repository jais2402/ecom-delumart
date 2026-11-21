"use client";

import { Alert, Heading, Switch, Text } from "@delulu/ui";
import { useSession } from "../../_lib/session-store";
import { PageHeading } from "../PageHeading";

/**
 * Read-only for now: the API has no profile route, so the handle is shown but privacy switches and
 * the research opt-out cannot be saved. They are displayed disabled so the gap is visible.
 */
export function ProfilePanel() {
  const session = useSession();
  const signedIn = session.status === "signedIn" ? session : null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Profile</PageHeading>
      <section aria-labelledby="handle" className="flex flex-col gap-1">
        <Heading level={2} size="md" id="handle">
          Your handle
        </Heading>
        <Text className="font-mono">{signedIn?.handle ? `@${signedIn.handle}` : "Not set"}</Text>
        {signedIn?.account ? (
          <Text size="sm" muted>
            DeluluPay id {signedIn.account.delulupayId}
          </Text>
        ) : null}
      </section>
      <section aria-labelledby="privacy" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="privacy">
          Privacy
        </Heading>
        <Alert tone="info">
          Editing privacy settings is not available yet. These switches show the defaults.
        </Alert>
        <div className="flex items-center justify-between gap-3">
          <span id="switch-handle" className="text-fg">
            Show my handle on public shop pages
          </span>
          <Switch aria-labelledby="switch-handle" checked disabled />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span id="switch-research" className="text-fg">
            Take part in research about how people play
          </span>
          <Switch aria-labelledby="switch-research" checked={false} disabled />
        </div>
      </section>
    </div>
  );
}
