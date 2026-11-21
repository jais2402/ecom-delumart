"use client";

import { STARTING_GRANT_PAISE } from "@delulu/core";
import { WelcomePanel } from "@delulu/ui";
import { useArrival } from "../../_lib/use-arrival";

/** A made-up number that fails the card checksum, so it can never pass for a real card. */
const DEMO_CARD_NUMBER = "9000000012345670";

export function DoneScreen() {
  const { ready, headingRef } = useArrival(5);
  if (!ready) return null;
  return (
    <WelcomePanel headingRef={headingRef} balancePaise={STARTING_GRANT_PAISE} cardNumber={DEMO_CARD_NUMBER} />
  );
}
