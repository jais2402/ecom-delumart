import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureRail } from "./FeatureRail";

const item = (id: string, name: string, pricePaise: bigint) => ({
  id,
  href: `/p/${id}`,
  name,
  hook: "A line.",
  pricePaise,
  hue: 100,
  motif: "luxury" as const,
});

describe("FeatureRail", () => {
  it("is a section named by its two-tone heading, with one link per card", () => {
    render(
      <FeatureRail
        title="In focus."
        lead="Our priciest."
        items={[item("a", "Alpha", 12_345_00n), item("b", "Beta", 99_900n)]}
      />,
    );
    const region = screen.getByRole("region", { name: "In focus. Our priciest." });
    expect(within(region).getAllByRole("link")).toHaveLength(2);
    expect(within(region).getByRole("link", { name: /Alpha/ })).toHaveAttribute("href", "/p/a");
  });
  it("shows the exact price from integer paise after 'From'", () => {
    render(<FeatureRail title="t" items={[item("a", "Alpha", 12_345_00n)]} />);
    expect(screen.getByText(/From/)).toBeInTheDocument();
    expect(screen.getAllByText(/12,345/).length).toBeGreaterThan(0);
  });
  it("is keyboard reachable and renders nothing without items", async () => {
    const { container, rerender } = render(<FeatureRail title="t" items={[item("a", "Alpha", 1n)]} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: /Alpha/ })).toHaveFocus();
    rerender(<FeatureRail title="t" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
