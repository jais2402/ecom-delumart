"use client";

import { Alert, Button, CreatorRoutes, Heading, Text, UnlockCelebration } from "@delulu/ui";
import { useEffect, useState } from "react";
import { parsePaiseOrNull } from "../../_lib/money";
import {
  type CompanyView,
  type CreatorAccessResponse,
  STARTING_BALANCE_PAISE,
  unlockRouteText,
} from "../../_lib/selling";
import { nextOnboardingPath, useSession } from "../../_lib/session-store";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

const THRESHOLD_FALLBACK = 10_000_000n * 100n;

const PASSPORT_LABELS = {
  quiz: "Pass the short quiz",
  saves: "Save three products",
  concept: "Write a private concept",
} as const;

function useCelebration(access: CreatorAccessResponse | null) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!access?.unlocked) return;
    const key = `dm.creator-celebrated.${access.unlockedAt ?? "now"}`;
    try {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, "1");
        setShow(true);
      }
    } catch {
      // storage is a convenience only: without it the panel simply does not show
    }
  }, [access]);
  return [show, () => setShow(false)] as const;
}

/** /sell: what selling is, both ways to unlock it with live progress, and the next step. */
export function SellPanel() {
  const session = useSession();
  const signedIn = session.status === "signedIn";
  const onboarded = signedIn && nextOnboardingPath(session.onboarding, false) === "/account";
  const access = useApiGet<CreatorAccessResponse>(onboarded ? "/api/v1/creator-access" : null);
  const unlocked = access.status === "ready" && access.data.unlocked;
  const company = useApiGet<{ company: CompanyView | null }>(unlocked ? "/api/v1/company" : null);
  const [celebrate, dismiss] = useCelebration(access.status === "ready" ? access.data : null);

  const signInAction = (
    <Button asChild size="lg">
      <a href="/sign-in?next=%2Fsell">Sign in to start</a>
    </Button>
  );

  const intro = (
    <section aria-label="How selling works" className="flex flex-col gap-2">
      <Text size="lg">Selling on DeluluMart is a game inside the game.</Text>
      <ul className="flex max-w-reading list-disc flex-col gap-1 pl-5">
        <li>Unlock creator access by one of two routes. Both are open to everyone.</li>
        <li>Register a shop with a one-time setup fee of fictional money.</li>
        <li>List impossible products. Nothing real is ever sold or shipped.</li>
      </ul>
    </section>
  );

  const thresholdOf = (a: CreatorAccessResponse) =>
    parsePaiseOrNull(a.routes.spend.thresholdPaise) ?? THRESHOLD_FALLBACK;

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Sell on DeluluMart</PageHeading>
      {intro}

      {session.status === "loading" ? <LoadingBlock rows={2} label="Loading" /> : null}
      {session.status === "error" ? (
        <ErrorBlock message={session.message} onRetry={() => location.reload()} />
      ) : null}

      {session.status === "signedOut" ? (
        <CreatorRoutes
          signedOut
          signInAction={signInAction}
          spend={{
            balancePaise: null,
            thresholdPaise: THRESHOLD_FALLBACK,
            startingBalancePaise: STARTING_BALANCE_PAISE,
            reached: false,
          }}
          passport={{
            href: "/sell/passport",
            steps: [
              { label: PASSPORT_LABELS.quiz, done: false },
              { label: PASSPORT_LABELS.saves, done: false },
              { label: PASSPORT_LABELS.concept, done: false },
            ],
          }}
        />
      ) : null}

      {signedIn && !onboarded ? (
        <Alert tone="info" title="Finish setting up your account first">
          <a className="text-action underline" href={nextOnboardingPath(session.onboarding, false)}>
            Continue setting up
          </a>
        </Alert>
      ) : null}

      {onboarded && access.status === "loading" ? (
        <LoadingBlock rows={2} label="Loading your progress" />
      ) : null}
      {onboarded && access.status === "error" ? (
        <ErrorBlock message={access.message} onRetry={access.reload} />
      ) : null}

      {onboarded && access.status === "ready" ? (
        <>
          {access.data.unlocked && celebrate ? (
            <UnlockCelebration
              routeText={unlockRouteText(access.data.source)}
              onDismiss={dismiss}
              action={
                company.status === "ready" && company.data.company ? (
                  <Button asChild>
                    <a href="/sell/shop">Go to your shop</a>
                  </Button>
                ) : (
                  <Button asChild>
                    <a href="/sell/register">Register a shop</a>
                  </Button>
                )
              }
            />
          ) : null}
          <CreatorRoutes
            unlockedBy={
              access.data.source === "PURCHASE_THRESHOLD"
                ? "SPEND"
                : access.data.source === "ACHIEVEMENT"
                  ? "PASSPORT"
                  : null
            }
            spend={{
              balancePaise: parsePaiseOrNull(access.data.routes.spend.balancePaise),
              thresholdPaise: thresholdOf(access.data),
              startingBalancePaise: STARTING_BALANCE_PAISE,
              reached: access.data.routes.spend.reached,
            }}
            passport={{
              href: "/sell/passport",
              steps: [
                { label: PASSPORT_LABELS.quiz, done: access.data.routes.passport.steps.quiz.done },
                {
                  label: `${PASSPORT_LABELS.saves} (${access.data.routes.passport.steps.saves.count} of ${access.data.routes.passport.steps.saves.required})`,
                  done: access.data.routes.passport.steps.saves.done,
                },
                { label: PASSPORT_LABELS.concept, done: access.data.routes.passport.steps.concept.done },
              ],
            }}
          />
          <NextStep
            unlocked={access.data.unlocked}
            company={company.status === "ready" ? company.data.company : undefined}
            companyLoading={access.data.unlocked && company.status === "loading"}
          />
        </>
      ) : null}
    </div>
  );
}

function NextStep({
  unlocked,
  company,
  companyLoading,
}: {
  unlocked: boolean;
  company: CompanyView | null | undefined;
  companyLoading: boolean;
}) {
  if (!unlocked) {
    return (
      <Text size="sm" muted>
        Registering a shop opens as soon as either route is complete. Nothing here is a countdown: take your
        time.
      </Text>
    );
  }
  if (companyLoading || company === undefined)
    return <LoadingBlock rows={1} label="Checking for your shop" />;
  return (
    <section
      aria-labelledby="next-step"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
    >
      <Heading level={2} size="sm" id="next-step">
        {company ? "Your shop" : "Next step: register a shop"}
      </Heading>
      {company ? (
        <>
          <Text>
            {company.displayName} is open at{" "}
            <span className="break-all font-mono">/store/{company.handle}</span>.
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href="/sell/shop">Open your shop</a>
            </Button>
            <Button asChild variant="secondary">
              <a href={`/store/${company.handle}`}>View public page</a>
            </Button>
          </div>
        </>
      ) : (
        <>
          <Text>Pick a handle and a name, review the one-time fee, and your shop opens.</Text>
          <Button asChild className="self-start">
            <a href="/sell/register">Register a shop</a>
          </Button>
        </>
      )}
    </section>
  );
}
