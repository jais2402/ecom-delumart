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
