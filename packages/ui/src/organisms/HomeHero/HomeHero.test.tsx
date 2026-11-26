import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HomeHero } from "./HomeHero";

const card = (n: number) => ({
  id: `c${n}`,
  href: `/p/c${n}`,
  eyebrow: `Eyebrow ${n}`,
  headline: `Headline ${n}`,
  linkLabel: "Shop now",
  hue: n * 40,
  motif: "tech" as const,
});
const cards = [card(1), card(2), card(3), card(4)];

describe("HomeHero", () => {
  it("is a named row of promo cards whose first headline is the page's one h1", () => {
    render(<HomeHero cards={cards} />);
    expect(screen.getByRole("region", { name: "Featured" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Headline 1" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
  });
  it("gives each card a keyboard reachable link and the row previous and next buttons", async () => {
    render(<HomeHero cards={cards} />);
    expect(screen.getByRole("button", { name: "Previous in Featured" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next in Featured" })).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Shop now: Headline 1" })).toHaveFocus();
  });
  it("never advances by itself and has no pause control", () => {
    render(<HomeHero cards={cards} />);
    expect(screen.queryByRole("button", { name: /pause|play/i })).not.toBeInTheDocument();
  });
});
