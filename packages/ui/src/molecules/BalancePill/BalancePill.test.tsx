import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BalancePill } from "./BalancePill";

describe("BalancePill", () => {
  it("shows the balance and the fictional-money label", () => {
    render(<BalancePill balancePaise={10_000_000_00n} />);
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.getByText("fictional money")).toBeVisible();
  });
  it("exposes an exact spoken label", () => {
    render(<BalancePill balancePaise={10_000_000_00n} />);
    expect(screen.getByText(/fictional rupees/)).toBeInTheDocument();
  });
  it("supports exact display", () => {
    render(<BalancePill balancePaise={12_345_00n} display="exact" />);
    expect(screen.getAllByText(/12,345/).length).toBeGreaterThan(0);
  });
  it("has a band tone for the header and still carries the fictional-money label", () => {
    const { container } = render(<BalancePill balancePaise={100n} tone="band" />);
    expect(container.firstElementChild).toHaveClass("border-border-on-band");
    expect(screen.getByText("fictional money")).toBeInTheDocument();
  });
});
