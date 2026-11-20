import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StockBadge } from "./StockBadge";

describe("StockBadge", () => {
  it("renders in stock", () => {
    render(<StockBadge state="in-stock" />);
    expect(screen.getByText("In stock")).toBeInTheDocument();
  });
  it("renders low stock with the count", () => {
    render(<StockBadge state="low" count={3} />);
    expect(screen.getByText("Only 3 left")).toBeInTheDocument();
  });
  it("renders sold out and edition as text", () => {
    const { rerender } = render(<StockBadge state="sold-out" />);
    expect(screen.getByText("Sold out")).toBeVisible();
    rerender(<StockBadge state="edition" number={7} of={100} />);
    expect(screen.getByText("#7 of 100")).toBeVisible();
  });
});
