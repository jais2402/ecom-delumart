import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CreatorBand } from "./CreatorBand";

const props = {
  title: "Got an idea nobody has had?",
  text: "Open a shop and sell it.",
  cta: { label: "Start selling", href: "/sell" },
} as const;

describe("CreatorBand", () => {
  it("has a heading, a line and a call to action", () => {
    render(<CreatorBand {...props} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Got an idea nobody has had?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start selling" })).toHaveAttribute("href", "/sell");
  });
  it("keeps the call to action keyboard reachable", async () => {
    render(<CreatorBand {...props} className="x-test" />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Start selling" })).toHaveFocus();
  });
});
