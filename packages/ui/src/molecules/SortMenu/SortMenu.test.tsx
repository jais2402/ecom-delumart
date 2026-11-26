import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortMenu } from "./SortMenu";

const options = [
  { key: "match", label: "Best match" },
  { key: "low", label: "Price low to high" },
  { key: "high", label: "Price high to low" },
] as const;

describe("SortMenu", () => {
  it("shows the chosen option in the pill and opens a menu of radio items", async () => {
    render(<SortMenu options={options} value="match" onChange={() => {}} />);
    const pill = screen.getByRole("button", { name: /Sort by: Best match/ });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: "Best match" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Price low to high" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
  it("walks the items with the arrow keys, chooses with Enter and returns focus to the pill", async () => {
    const onChange = vi.fn();
    render(<SortMenu options={options} value="match" onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitemradio", { name: "Best match" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Price high to low" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sort by/ })).toHaveFocus();
  });
  it("Escape closes the menu without choosing and returns focus to the pill", async () => {
    const onChange = vi.fn();
    render(<SortMenu options={options} value="match" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /Sort by/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Sort by/ })).toHaveFocus();
  });
});
