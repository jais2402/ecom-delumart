import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HomeHero } from "./HomeHero";

const slide = (n: number) => ({
  id: `p${n}`,
  href: `/p/p${n}`,
  name: `Product ${n}`,
  hook: `Hook ${n}`,
  pricePaise: BigInt(n) * 100_000n,
  hue: n * 40,
  motif: "tech" as const,
});
const props = {
  title: "₹100 crore welcome balance for every new account.",
  text: "Create an account, pick something and have it on its way in minutes.",
  slides: [slide(1), slide(2), slide(3)],
};

describe("HomeHero", () => {
  it("has the page's one h1 in a slim banner and a carousel of featured products", () => {
    render(<HomeHero {...props} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "₹100 crore welcome balance for every new account." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Featured products" })).toHaveAttribute(
      "aria-roledescription",
      "carousel",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Product 1" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /^\d of 3$/ })).toHaveLength(3);
  });
  it("links Shop now to the product it features", () => {
    render(<HomeHero {...props} />);
    expect(screen.getByRole("link", { name: "Shop now: Product 1" })).toHaveAttribute("href", "/p/p1");
  });
  it("moves on Next and Previous (wrapping) and on a dot, and never advances by itself", async () => {
    render(<HomeHero {...props} />);
    const dot = (n: number) => screen.getByRole("button", { name: `Show featured product ${n} of 3` });
    expect(dot(1)).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: "Next featured product" }));
    expect(dot(2)).toHaveAttribute("aria-current", "true");
    await userEvent.click(dot(3));
    expect(dot(3)).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: "Next featured product" }));
    expect(dot(1)).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: "Previous featured product" }));
    expect(dot(3)).toHaveAttribute("aria-current", "true");
  });
  it("keeps slides out of view inert, so only the visible slide's link can be tabbed to", async () => {
    render(<HomeHero {...props} />);
    const slides = screen.getAllByRole("group", { name: /^\d of 3$/ });
    expect(slides[0]).not.toHaveAttribute("inert");
    expect(slides[1]).toHaveAttribute("inert");
    await userEvent.click(screen.getByRole("button", { name: "Next featured product" }));
    expect(slides[0]).toHaveAttribute("inert");
    expect(slides[1]).not.toHaveAttribute("inert");
  });
  it("puts the visible slide's link first in the tab order", async () => {
    render(<HomeHero {...props} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Shop now: Product 1" })).toHaveFocus();
  });
  it("draws no carousel without products, and no controls for a single one", () => {
    const { rerender } = render(<HomeHero {...props} slides={[]} />);
    expect(screen.queryByRole("group", { name: "Featured products" })).not.toBeInTheDocument();
    rerender(<HomeHero {...props} slides={[slide(1)]} />);
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
  });
});
