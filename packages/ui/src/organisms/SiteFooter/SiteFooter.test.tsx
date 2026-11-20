import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./SiteFooter";

describe("SiteFooter", () => {
  it("states that money is fictional and delivery is simulated", () => {
    render(<SiteFooter />);
    expect(
      screen.getByText("Fictional money only. Nothing real ships — delivery is simulated."),
    ).toBeInTheDocument();
  });
  it("renders supplied links in a labelled navigation", () => {
    render(<SiteFooter links={[{ label: "Terms", href: "/terms" }]} />);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("navigation", { name: "Footer" })).toBeInTheDocument();
  });
  it("is a contentinfo landmark", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
});
