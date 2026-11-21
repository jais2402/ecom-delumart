import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OverflowMenu } from "./OverflowMenu";

describe("OverflowMenu", () => {
  it("is a collapsed button named for what it does", () => {
    render(<OverflowMenu items={[{ label: "Block this shop", onSelect: () => {} }]} />);
    const button = screen.getByRole("button", { name: "More actions" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Block this shop" })).not.toBeInTheDocument();
  });
  it("opens, runs the chosen item and closes", async () => {
    const onSelect = vi.fn();
    render(<OverflowMenu items={[{ label: "Block this shop", onSelect }]} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "Block this shop" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Block this shop" })).not.toBeInTheDocument();
  });
  it("closes on Escape and returns focus to the button", async () => {
    render(<OverflowMenu items={[{ label: "Block this shop", onSelect: () => {} }]} />);
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Block this shop" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus();
  });
});
