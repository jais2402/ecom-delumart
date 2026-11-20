import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

describe("Switch", () => {
  it("has role switch and an accessible name", () => {
    render(<Switch aria-label="Notifications" />);
    expect(screen.getByRole("switch", { name: "Notifications" })).toHaveAttribute("aria-checked", "false");
  });
  it("toggles and reports the new value", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Notifications" onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
  it("toggles with the keyboard and respects controlled value", async () => {
    render(<Switch aria-label="Controlled" checked={false} />);
    screen.getByRole("switch").focus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});
