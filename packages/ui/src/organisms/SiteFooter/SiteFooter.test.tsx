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
  it("renders supplied link groups, each in its own labelled navigation", () => {
    render(<SiteFooter groups={[{ title: "Rules", links: [{ label: "Terms", href: "/terms" }] }]} />);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("navigation", { name: "Rules" })).toBeInTheDocument();
  });
  it("links the logo home and only to pages that exist by default", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: "DeluluMart" })).toHaveAttribute("href", "/");
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).toMatch(/^\/(search|cart|sell|account\/(wallet|orders))?$/);
    }
  });
  it("is a contentinfo landmark", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });
  it("has a dark band of three promises above the link columns", () => {
    render(<SiteFooter />);
    expect(screen.getByText("Fast delivery")).toBeInTheDocument();
    expect(screen.getByText("Secure checkout")).toBeInTheDocument();
    expect(screen.getByText("Independent shops")).toBeInTheDocument();
  });
});
