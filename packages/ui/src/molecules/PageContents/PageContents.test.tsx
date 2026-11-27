import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PageContents } from "./PageContents";

const items = [
  { label: "Delivery", href: "#delivery" },
  { label: "Reviews", href: "#reviews" },
] as const;

describe("PageContents", () => {
  it("is a navigation landmark named On this page, with one link per item", () => {
    render(<PageContents items={items} />);
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reviews" })).toHaveAttribute("href", "#reviews");
  });
  it("lets the keyboard reach each link in order", async () => {
    render(<PageContents items={items} label="In this policy" />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Delivery" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Reviews" })).toHaveFocus();
    expect(screen.getByRole("navigation", { name: "In this policy" })).toBeInTheDocument();
  });
});
