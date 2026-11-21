import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EarningsChart } from "./EarningsChart";

const rows = [
  { date: "2026-11-20", label: "20 Nov", orders: 0, grossPaise: 0n, netPaise: 0n },
  { date: "2026-11-21", label: "21 Nov", orders: 2, grossPaise: 500_000n, netPaise: 450_000n },
  { date: "2026-11-22", label: "22 Nov", orders: 1, grossPaise: 250_000n, netPaise: 225_000n },
];

describe("EarningsChart", () => {
  it("has a data table with one row per day carrying the same numbers", () => {
    render(<EarningsChart rows={rows} caption="Daily sales" />);
    const table = screen.getByRole("table", { name: /Daily sales/ });
    expect(within(table).getAllByRole("row")).toHaveLength(rows.length + 1);
    const row = within(table).getByRole("row", { name: /2026-11-21/ });
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("₹5,000");
    expect(row).toHaveTextContent("₹4,500");
  });
  it("summarises the period in text", () => {
    render(<EarningsChart rows={rows} caption="Daily sales" />);
    const summary = screen.getByTestId("chart-summary");
    expect(summary).toHaveTextContent("3 orders");
    expect(summary).toHaveTextContent("gross ₹7,500");
    expect(summary).toHaveTextContent("net ₹6,750");
  });
  it("tells the series apart without colour: pattern and marker shape, named in a key", () => {
    const { container } = render(<EarningsChart rows={rows} caption="Daily sales" />);
    const key = screen.getByRole("list", { name: "Chart key" });
    expect(key).toHaveTextContent("Gross sales (hatched bars)");
    expect(key).toHaveTextContent("Net earnings (dashed line, diamonds)");
    const bar = container.querySelector('[data-series="gross"]');
    const net = container.querySelector('[data-series="net"]');
    expect(bar?.getAttribute("fill")).toMatch(/^url\(#/);
    expect(net?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(net?.getAttribute("fill")).toBe("none");
    expect(container.querySelectorAll('[data-series="net-marker"]')).toHaveLength(rows.length);
  });
  it("names the chart image and makes the table region focusable", () => {
    render(<EarningsChart rows={rows} caption="Daily sales" />);
    expect(screen.getByRole("img", { name: /Daily sales/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Daily sales: data table" })).toHaveAttribute("tabindex", "0");
  });
  it("says so when nothing sold", () => {
    render(
      <EarningsChart
        rows={rows.map((r) => ({ ...r, orders: 0, grossPaise: 0n, netPaise: 0n }))}
        caption="Daily sales"
      />,
    );
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("No sales");
  });
});
