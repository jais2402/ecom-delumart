import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendStatGrid } from "./TrendStatGrid";

const stats = [
  { key: "orders", label: "Orders", value: "12", current: 12n, previous: 10n, previousValue: "10" },
  { key: "signups", label: "Sign-ups", value: "3", current: 3n, previous: 0n },
];

describe("TrendStatGrid", () => {
  it("renders one named list item per total with its change in words", () => {
    render(<TrendStatGrid stats={stats} aria-label="Totals" />);
    const list = screen.getByRole("list", { name: "Totals" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Orders");
    expect(items[0]).toHaveTextContent("Up 20.0% vs previous period");
    expect(items[1]).toHaveTextContent("No earlier data");
  });
});
