import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PromoTile } from "./PromoTile";

const props = {
  title: "Become a creator",
  text: "Sell your own impossible things.",
  cta: { label: "Open a shop", href: "/sell" },
  art: { hue: 20, seed: "x", motif: "magic" },
} as const;

describe("PromoTile", () => {
  it("has a heading, a line of text and one call to action", () => {
    render(<PromoTile {...props} />);
    expect(screen.getByRole("heading", { level: 2, name: "Become a creator" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open a shop" })).toHaveAttribute("href", "/sell");
  });
  it("takes keyboard focus on the call to action, in either tone, with decorative art", async () => {
    render(<PromoTile {...props} tone="brand" />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Open a shop" })).toHaveFocus();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
