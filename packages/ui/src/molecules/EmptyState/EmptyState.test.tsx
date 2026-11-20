import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders a heading and description", () => {
    render(<EmptyState title="Your cart is empty" description="Add something impossible." />);
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.getByText("Add something impossible.")).toBeInTheDocument();
  });
  it("renders the action slot", () => {
    render(<EmptyState title="Empty" action={<button type="button">Browse</button>} />);
    expect(screen.getByRole("button", { name: "Browse" })).toBeInTheDocument();
  });
  it("lets the heading level fit the page outline", () => {
    render(<EmptyState title="Empty" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });
});
