import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";

const items = [{ label: "Home", href: "/" }, { label: "Gadgets", href: "/gadgets" }, { label: "Teapot" }];

describe("Breadcrumbs", () => {
  it("is a labelled navigation landmark", () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });
  it("links ancestors", () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByRole("link", { name: "Gadgets" })).toHaveAttribute("href", "/gadgets");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
  it("marks the last item as the current page", () => {
    render(<Breadcrumbs items={items} />);
    expect(screen.getByText("Teapot")).toHaveAttribute("aria-current", "page");
  });
});
