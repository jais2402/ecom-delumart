import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FunnelChart } from "./FunnelChart";

const steps = [
  { key: "visitors", label: "Visitors", visitors: 1000, conversionFromPrevious: null },
  { key: "product_views", label: "Product views", visitors: 500, conversionFromPrevious: 0.5 },
  { key: "purchases", label: "Purchases", visitors: 25, conversionFromPrevious: 0.05 },
];

describe("FunnelChart", () => {
  it("renders a named ordered list with counts and step conversion in text", () => {
    render(<FunnelChart steps={steps} overallConversion={0.025} caption="Conversion funnel" />);
    const list = screen.getByRole("list", { name: "Conversion funnel: steps" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("1. Visitors");
    expect(items[0]).toHaveTextContent("start of the funnel");
    expect(items[1]).toHaveTextContent("50% of the step before");
    expect(items[2]).toHaveTextContent("5% of the step before");
    expect(screen.getByText(/Overall: 2.5%/)).toBeInTheDocument();
  });
  it("sizes bars by share of the first step", () => {
    render(<FunnelChart steps={steps} overallConversion={0.025} caption="Funnel" />);
    const bars = screen.getAllByTestId("funnel-bar");
    expect(bars.map((b) => b.style.width)).toEqual(["100%", "50%", "2.5%"]);
  });
  it("is labelled as a figure by its caption and handles an empty funnel", () => {
    render(
      <FunnelChart
        steps={steps.map((s) => ({ ...s, visitors: 0, conversionFromPrevious: null }))}
        overallConversion={null}
        caption="Funnel"
      />,
    );
    expect(screen.getByRole("figure", { name: "Funnel" })).toBeInTheDocument();
    expect(screen.getByText(/not available/)).toBeInTheDocument();
    expect(screen.getAllByTestId("funnel-bar")[0]?.style.width).toBe("0%");
  });
});
