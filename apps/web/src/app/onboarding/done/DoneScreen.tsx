"use client";

import { formatInrCompact } from "@delulu/core";
import { Button, FictionLabel, Heading, Text, WelcomePanel } from "@delulu/ui";
import { useEffect, useState } from "react";
import { useGateway } from "../../_lib/gateway-context";
import { getReturnTo, safeReturnPath } from "../../_lib/onboarding-flow";
import { useSession } from "../../_lib/session-store";
import { useArrival } from "../../_lib/use-arrival";

export function DoneScreen() {
  const gateway = useGateway();
  const { ready, headingRef } = useArrival(5);
  const session = useSession();
  const [cardNumber, setCardNumber] = useState<string | null>(null);
  const [cardChecked, setCardChecked] = useState(false);

  // The number is shown masked by the card and kept in memory only; a fresh sign-in allows the reveal.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      const card = await gateway.welcomeCard().catch(() => null);
      const number = card ? await gateway.revealCardNumber(card.cardId) : null;
      if (!cancelled) {
        setCardNumber(number);
        setCardChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, gateway]);

  const showing = ready && cardChecked && session.status !== "loading";
  useEffect(() => {
    if (showing) headingRef.current?.focus();
  }, [showing, headingRef]);

  if (!ready || session.status === "loading" || !cardChecked)
    return <p role="status">Loading your account…</p>;
  const balance = session.status === "signedIn" ? session.balancePaise : null;
  const stored = getReturnTo();
  const shopHref = stored === null ? "/" : safeReturnPath(stored, window.location.origin);

  if (cardNumber && balance !== null) {
    return (
      <div className="flex flex-col gap-4">
        <WelcomePanel
          headingRef={headingRef}
          balancePaise={balance}
          cardNumber={cardNumber}
          shopHref={shopHref}
          holderName={session.status === "signedIn" && session.handle ? session.handle : "Delulu Player"}
        />
        <Button asChild variant="secondary" size="lg">
          <a href="/account">Go to your account</a>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        You&apos;re in. Welcome to DeluluMart.
      </Heading>
      {balance !== null ? (
        <div className="flex flex-col gap-1 rounded-lg bg-action-soft p-4">
          <FictionLabel>Your starting balance</FictionLabel>
          <p className="font-display text-3xl font-bold text-fg">
            {formatInrCompact(balance)} · fictional money
          </p>
        </div>
      ) : null}
      <Text muted>Your card is ready. Open your account to see it.</Text>
      <Button asChild size="lg">
        <a href={shopHref}>Start shopping</a>
      </Button>
      <Button asChild variant="secondary" size="lg">
        <a href="/account">Go to your account</a>
      </Button>
    </div>
  );
}
