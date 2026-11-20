import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterPanel } from "./FilterPanel";

const steps = [
  { value: "1000", label: "₹1,000" },
  { value: "100000", label: "₹1 lakh" },
];

function setup(overrides = {}) {
  const handlers = {
    onCategoryChange: vi.fn(),
    onPriceChange: vi.fn(),
    onZapOnlyChange: vi.fn(),
    onReset: vi.fn(),
  };
  render(
    <FilterPanel
      categories={[{ slug: "a", name: "Alpha" }]}
      category="a"
      priceSteps={steps}
      minPrice=""
      maxPrice=""
      zapOnly={false}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("FilterPanel", () => {
  it("marks the selected category as pressed and reports category changes", async () => {
    const h = setup();
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "All categories" }));
    expect(h.onCategoryChange).toHaveBeenCalledWith(undefined);
  });
  it("reports price range and Zap changes", async () => {
    const h = setup();
    await userEvent.selectOptions(screen.getByLabelText("Maximum price"), "100000");
    expect(h.onPriceChange).toHaveBeenCalledWith({ min: "", max: "100000" });
    await userEvent.click(screen.getByRole("switch", { name: "Zap available" }));
    expect(h.onZapOnlyChange).toHaveBeenCalledWith(true);
  });
  it("is a named form and the reset button calls back", async () => {
    const h = setup({ categories: undefined });
    expect(screen.getByRole("form", { name: "Filters" })).toBeInTheDocument();
    expect(screen.queryByText("Category")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(h.onReset).toHaveBeenCalled();
  });
});
