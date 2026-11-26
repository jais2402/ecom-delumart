import { DEFAULT_DELIVERY_DURATIONS_MS } from "@delulu/core";
import type { Speed } from "./api";

/** Words for each delivery speed; the arrival times are the simulated ones the shipment follows. */
export const SPEED_COPY: Record<Speed, { name: string; arrival: string }> = {
  STANDARD: { name: "Standard", arrival: "Arrives in about 24 hours" },
  EXPRESS: { name: "Express", arrival: "Arrives in about 2 hours" },
  ZAP: { name: "Zap", arrival: "Arrives in about 10 minutes" },
};

export function isSpeed(value: string): value is Speed {
  return value === "STANDARD" || value === "EXPRESS" || value === "ZAP";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a delivery speed takes, from the configured durations: "about 24 hours", "about 10 minutes". */
export function arrivalPhrase(speed: Speed): string {
  const ms = DEFAULT_DELIVERY_DURATIONS_MS[speed];
  return ms % HOUR_MS === 0 ? `about ${ms / HOUR_MS} hours` : `about ${Math.round(ms / MINUTE_MS)} minutes`;
}

/** The header's delivery pill: its label, and the speeds its popover explains with their configured arrival times. */
export const DELIVERY_PILL = {
  label: "Standard or Zap delivery",
  speeds: (["STANDARD", "EXPRESS", "ZAP"] as const).map((speed) => ({
    name: SPEED_COPY[speed].name,
    arrival: `Arrives in ${arrivalPhrase(speed)}`,
  })),
  helpHref: "/#how-it-works",
} as const;
