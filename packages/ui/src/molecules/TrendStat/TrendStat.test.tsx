import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeTrend, TrendStat } from "./TrendStat";

describe("describeTrend", () => {
  it("computes whole-number percentages with bigint and names the direction", () => {
    expect(describeTrend(125n, 100n)).toEqual({ direction: "up", text: "Up 25.0% vs previous period" });
    expect(describeTrend(75n, 100n)).toEqual({ direction: "down", text: "Down 25.0% vs previous period" });
    expect(describeTrend(1_000_000_000_000_000_001n, 1_000_000_000_000_000_000n).text).toBe(
      "Up 0.0% vs previous period",
    );
    expect(describeTrend(12840n, 11000n).text).toBe("Up 16.7% vs previous period");
    expect(describeTrend(5n, 5n).direction).toBe("flat");
  });
  it("says there is no earlier data when the previous period is zero or missing", () => {
    expect(describeTrend(5n, 0n).text).toBe("No earlier data");
    expect(describeTrend(5n, null).text).toBe("No earlier data");
  });
});

describe("TrendStat", () => {
  it("shows label, value and a text change with the earlier value", () => {
    const { container } = render(
      <TrendStat label="Orders" value="120" current={120n} previous={100n} previousValue="100" />,
    );
    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("Up 20.0% vs previous period")).toBeInTheDocument();
    expect(screen.getByText("(was 100)")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
  it("names the term for the value (accessible name via the definition list)", () => {
    render(<TrendStat label="Sign-ups" value="0" current={0n} previous={0n} />);
    expect(screen.getByRole("term")).toHaveTextContent("Sign-ups");
    expect(screen.getByText("No earlier data")).toBeInTheDocument();
  });
});
