import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeliveryPill } from "./DeliveryPill";

const speeds = [
  { name: "Standard", arrival: "Arrives in about 24 hours" },
  { name: "Zap", arrival: "Arrives in about 10 minutes" },
] as const;

describe("DeliveryPill", () => {
  it("is a closed button until pressed, then explains each speed and links to How it works", async () => {
    render(<DeliveryPill label="Standard or Zap delivery" speeds={speeds} helpHref="/#how-it-works" />);
    const button = screen.getByRole("button", { name: "Standard or Zap delivery" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Delivery speeds" });
    expect(panel).toHaveTextContent("Arrives in about 10 minutes");
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/#how-it-works");
  });
  it("Escape closes the popover and returns focus to the pill", async () => {
    render(<DeliveryPill label="Standard or Zap delivery" speeds={speeds} helpHref="/#how-it-works" />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Delivery speeds" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Standard or Zap delivery" })).toHaveFocus();
  });
});
