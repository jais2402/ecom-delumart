import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PromoCard } from "./PromoCard";

const item = {
  id: "a",
  href: "/p/jar",
  eyebrow: "Everyday Magic",
  headline: "Monsoon in a Jar",
  linkLabel: "Shop now",
  hue: 200,
  motif: "magic",
} as const;

describe("PromoCard", () => {
  it("shows the eyebrow and a headline of the chosen level, with a decorative picture", () => {
    render(<PromoCard item={item} headingLevel={1} />);
    expect(screen.getByText("Everyday Magic")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Monsoon in a Jar" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("has one link, keyboard reachable, named with its label and the headline", async () => {
    render(<PromoCard item={item} />);
    await userEvent.tab();
    const link = screen.getByRole("link", { name: "Shop now: Monsoon in a Jar" });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute("href", "/p/jar");
    expect(link).toHaveClass("underline");
  });
  it("is the band colour by default and amber when warm", () => {
    const { container, rerender } = render(<PromoCard item={item} />);
    expect(container.firstElementChild).toHaveClass("bg-band");
    rerender(<PromoCard item={{ ...item, tone: "warm" }} />);
    expect(container.firstElementChild).toHaveClass("bg-cta");
  });
});
