import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatGrid } from "./StatGrid";

const stats = [
  { label: "Orders", value: "42", change: "+4 vs last week" },
  { label: "Sales", value: "₹3 crore", asOf: "As of 9:00 am" },
];

describe("StatGrid", () => {
  it("renders each stat as a list item with label and value", () => {
    render(<StatGrid stats={stats} aria-label="Key figures" />);
    expect(screen.getByRole("list", { name: "Key figures" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("₹3 crore")).toBeInTheDocument();
  });
  it("shows change and as-of text only when given", () => {
    render(<StatGrid stats={stats} />);
    expect(screen.getByText("+4 vs last week")).toBeInTheDocument();
    expect(screen.getByText("As of 9:00 am")).toBeInTheDocument();
  });
});
