import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineChart } from "./LineChart";

const fmt = (v: bigint) => `${v} visits`;
const rows = [
  { date: "2026-11-19", label: "19 Nov", value: 10n },
  { date: "2026-11-20", label: "20 Nov", value: 30n },
  { date: "2026-11-21", label: "21 Nov", value: null },
  { date: "2026-11-22", label: "22 Nov", value: 20n },
];

describe("LineChart", () => {
  it("has a data table with a row per day; a missing day reads as not available, never zero", () => {
    render(<LineChart rows={rows} caption="Visitors" valueLabel="Visitors" formatValue={fmt} />);
    const table = screen.getByRole("table", { name: /Visitors/ });
    expect(within(table).getAllByRole("row")).toHaveLength(rows.length + 1);
    expect(within(table).getByRole("row", { name: /2026-11-20/ })).toHaveTextContent("30 visits");
    const gap = within(table).getByRole("row", { name: /2026-11-21/ });
    expect(gap).toHaveTextContent("Not available yet");
    expect(gap).not.toHaveTextContent("0 visits");
  });
  it("summarises in text, counting gaps", () => {
    render(<LineChart rows={rows} caption="Visitors" valueLabel="Visitors" formatValue={fmt} />);
    const summary = screen.getByTestId("chart-summary");
    expect(summary).toHaveTextContent("3 of 4 days have data");
    expect(summary).toHaveTextContent("Total 60 visits");
    expect(summary).toHaveTextContent("Peak 30 visits on 2026-11-20");
    expect(summary).toHaveTextContent("1 day has no figure yet");
  });
  it("breaks the line at a gap: two runs, one tick on the baseline, and a key entry for it", () => {
    const { container } = render(
      <LineChart
        rows={[...rows, { date: "2026-11-23", label: "23 Nov", value: 25n }]}
        caption="Visitors"
        valueLabel="Visitors"
        formatValue={fmt}
      />,
    );
    // run 1 = two days (line), run 2 = two days (line)
    expect(container.querySelectorAll('[data-series="line"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="gap"]')).toHaveLength(1);
    expect(screen.getByRole("list", { name: "Chart key" })).toHaveTextContent("a gap, not zero");
  });
  it("draws a lone day as a marker and names the chart image; the table is focusable", () => {
    const { container } = render(
      <LineChart
        rows={[
          { date: "2026-11-19", label: "19 Nov", value: null },
          { date: "2026-11-20", label: "20 Nov", value: 5n },
          { date: "2026-11-21", label: "21 Nov", value: null },
        ]}
        caption="Visitors"
        valueLabel="Visitors"
        formatValue={fmt}
      />,
    );
    expect(container.querySelectorAll('[data-series="line"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-series="marker"]')).toHaveLength(1);
    expect(screen.getByRole("img", { name: /Visitors\. The table below/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Visitors: data table" })).toHaveAttribute("tabindex", "0");
  });
  it("says so when there is no data at all", () => {
    render(
      <LineChart
        rows={[{ date: "2026-11-19", label: "19 Nov", value: null }]}
        caption="Visitors"
        valueLabel="Visitors"
        formatValue={fmt}
      />,
    );
    expect(screen.getByTestId("chart-summary")).toHaveTextContent("No data in these 1 days.");
  });
});
