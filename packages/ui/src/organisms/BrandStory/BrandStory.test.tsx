import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandStory } from "./BrandStory";

const stats = [
  { label: "Products", value: "50" },
  { label: "Categories", value: "6" },
  { label: "Shops", value: "3" },
];

describe("BrandStory", () => {
  it("is a section with a heading and the statement", () => {
    render(<BrandStory title="One store, every shelf." text="Browse everything in one place." />);
    expect(screen.getByRole("heading", { level: 2, name: "One store, every shelf." })).toBeInTheDocument();
    expect(screen.getByText("Browse everything in one place.")).toBeInTheDocument();
  });
  it("lists each figure with its label", () => {
    render(<BrandStory title="t" text="x" stats={stats} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
  });
  it("draws no figures row when none are given, and merges the class name", () => {
    const { container } = render(<BrandStory title="t" text="x" className="x-test" />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
