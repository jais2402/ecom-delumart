import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceBadge } from "./SourceBadge";

describe("SourceBadge", () => {
  it.each([
    ["player", "PLAYER"],
    ["npc", "Simulated NPC"],
    ["staff", "STAFF"],
  ] as const)("renders %s as text", (source, text) => {
    render(<SourceBadge source={source} />);
    expect(screen.getByText(text)).toBeVisible();
  });
  it("uses the source colour token alongside the text", () => {
    render(<SourceBadge source="npc" />);
    expect(screen.getByText("Simulated NPC")).toHaveClass("text-source-npc");
  });
  it("is not hidden from assistive tech", () => {
    render(<SourceBadge source="player" />);
    expect(screen.getByText("PLAYER")).not.toHaveAttribute("aria-hidden");
  });
});
