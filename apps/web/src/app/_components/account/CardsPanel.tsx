"use client";

import { Alert, Button, EmptyState, Heading, PinField, PinSetupForm, RevealableCard, Text } from "@delulu/ui";
import { useState } from "react";
import { ApiError, api, describeError, type WalletResponse } from "../../_lib/api";
import { refreshSession, useSession } from "../../_lib/session-store";
import { useApiGet } from "../../_lib/use-api";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

type PinMode = "closed" | "change" | "reset";

export function CardsPanel() {
  const wallet = useApiGet<WalletResponse>("/api/v1/wallet");
  const session = useSession();
  const [number, setNumber] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealNote, setRevealNote] = useState<{ tone: "warning" | "danger"; text: string } | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<PinMode>("closed");
  const [currentPin, setCurrentPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinPending, setPinPending] = useState(false);
  const [pinDone, setPinDone] = useState(false);

  if (wallet.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Cards</PageHeading>
        <LoadingBlock rows={3} label="Loading your card" />
      </div>
    );
  }
  if (wallet.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Cards</PageHeading>
        <ErrorBlock message={wallet.message} onRetry={wallet.reload} />
      </div>
    );
  }
  const card = wallet.data.card;
  if (!card) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeading>Cards</PageHeading>
        <EmptyState title="No card yet" description="Finish onboarding to get your Delulu Card." />
      </div>
    );
  }
  const frozen = card.status === "FROZEN";
  const holder = session.status === "signedIn" && session.handle ? session.handle : "Delulu Player";

  async function reveal() {
    if (!card) return;
    setRevealing(true);
    setRevealNote(null);
    try {
      const result = await api<{ cardNumber: string }>(`/api/v1/cards/${card.id}/reveal`, {
        method: "POST",
        body: {},
      });
      setNumber(result.cardNumber);
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") {
        setRevealNote({
          tone: "warning",
          text: "For safety, showing the full number needs a recent sign-in. Sign out, sign in again, then try once more.",
        });
      } else {
        setRevealNote({ tone: "danger", text: describeError(err) });
      }
    } finally {
      setRevealing(false);
    }
  }

  async function setFrozen(next: boolean) {
    if (!card) return;
    setFreezing(true);
    setFreezeError(null);
    try {
      await api(`/api/v1/cards/${card.id}/freeze`, { method: "POST", body: { frozen: next } });
      wallet.reload();
      void refreshSession();
    } catch (err) {
      setFreezeError(describeError(err));
    } finally {
      setFreezing(false);
    }
  }

  async function savePin(pin: string) {
    if (!card) return;
    setPinPending(true);
    setPinError(null);
    try {
      if (pinMode === "reset") {
        await api(`/api/v1/cards/${card.id}/pin/reset`, { method: "POST", body: { pin } });
      } else {
        await api(`/api/v1/cards/${card.id}/pin`, {
          method: "POST",
          body: card.pinSet ? { pin, currentPin } : { pin },
        });
      }
      setPinDone(true);
      setPinMode("closed");
      setCurrentPin("");
      wallet.reload();
      void refreshSession();
    } catch (err) {
      if (err instanceof ApiError && err.code === "REAUTH_REQUIRED") {
        setPinError(
          "Resetting your PIN needs a recent sign-in. Sign out, sign in again, then try once more.",
        );
      } else {
        setPinError(describeError(err));
      }
      throw err;
    } finally {
      setPinPending(false);
    }
  }

  const asking = pinMode !== "closed" || !card.pinSet;
  const mode: PinMode = !card.pinSet ? "change" : pinMode;

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Cards</PageHeading>

      <section aria-labelledby="card-heading" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="card-heading">
          Your Delulu Card
        </Heading>
        <RevealableCard
          holderName={holder}
          lastFour={card.lastFour}
          number={number}
          frozen={frozen}
          revealing={revealing}
          onReveal={() => void reveal()}
          onHide={() => setNumber(null)}
        />
        {revealNote ? (
          <Alert
            tone={revealNote.tone}
            title={revealNote.tone === "warning" ? "Sign in again to reveal" : undefined}
          >
            {revealNote.text}
          </Alert>
        ) : null}
        <Text size="sm" muted>
          A game card for DeluluMart only. It cannot be used anywhere real.
        </Text>
      </section>

      <section aria-labelledby="freeze-heading" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="freeze-heading">
          {frozen ? "Card is frozen" : "Freeze card"}
        </Heading>
        <Text muted>
          {frozen
            ? "Payments with this card are paused. You can still pay from your bank balance."
            : "Freeze the card to pause payments with it. You can unfreeze it any time."}
        </Text>
        {freezeError ? <Alert tone="danger">{freezeError}</Alert> : null}
        <Button
          variant="secondary"
          loading={freezing}
          onClick={() => void setFrozen(!frozen)}
          className="self-start"
        >
          {frozen ? "Unfreeze card" : "Freeze card"}
        </Button>
      </section>

      <section aria-labelledby="pin-heading" className="flex flex-col gap-3">
        <Heading level={2} size="md" id="pin-heading">
          Game PIN
        </Heading>
        {pinDone ? <Alert tone="success">Your game PIN is saved.</Alert> : null}
        {!asking ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setPinDone(false);
                setPinError(null);
                setPinMode("change");
              }}
            >
              Change PIN
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPinDone(false);
                setPinError(null);
                setPinMode("reset");
              }}
            >
              I forgot my PIN
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {card.pinSet && mode === "change" ? (
              <PinField
                label="Current game PIN"
                hint="Your PIN today."
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value)}
              />
            ) : null}
            <PinSetupForm
              title={
                !card.pinSet
                  ? "Set your game PIN"
                  : mode === "reset"
                    ? "Reset your game PIN"
                    : "Choose a new game PIN"
              }
              headingLevel={3}
              submitLabel={!card.pinSet ? "Save PIN" : mode === "reset" ? "Reset PIN" : "Change PIN"}
              birthdate=""
              pending={pinPending}
              error={pinError}
              onSubmit={savePin}
            />
            {card.pinSet ? (
              <Button variant="ghost" onClick={() => setPinMode("closed")} className="self-start">
                Cancel
              </Button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
