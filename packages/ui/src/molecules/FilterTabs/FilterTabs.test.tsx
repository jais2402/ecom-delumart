import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterTabs } from "./FilterTabs";

const options = [
  { key: "all", label: "All" },
  { key: "tech", label: "Impossible Tech" },
  { key: "food", label: "Food Fantasies" },
];

describe("FilterTabs", () => {
  it("is a named group of toggle buttons with only the chosen one pressed", () => {
    render(<FilterTabs label="Filter top picks" options={options} value="tech" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Filter top picks" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Impossible Tech" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });
  it("reports the chosen key on click and on Enter after tabbing there", async () => {
    const onChange = vi.fn();
    render(<FilterTabs label="Filter" options={options} value="all" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Food Fantasies" }));
    expect(onChange).toHaveBeenLastCalledWith("food");
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Impossible Tech" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("tech");
  });
  it("keeps every button 44px tall and merges the class name", () => {
    render(
      <FilterTabs label="Filter" options={options} value="all" onChange={() => {}} className="x-test" />,
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveClass("min-h-touch");
    expect(screen.getByRole("group")).toHaveClass("x-test");
  });
});
