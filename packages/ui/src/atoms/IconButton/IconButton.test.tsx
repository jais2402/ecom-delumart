import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  it("is named by aria-label", () => {
    render(<IconButton aria-label="Close">x</IconButton>);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
  it("fires onClick, not when disabled", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <IconButton aria-label="Go" onClick={onClick}>
        x
      </IconButton>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <IconButton aria-label="Go" onClick={onClick} disabled>
        x
      </IconButton>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("has a 44px touch target", () => {
    render(<IconButton aria-label="Go">x</IconButton>);
    expect(screen.getByRole("button")).toHaveClass("min-h-touch", "min-w-touch");
  });
});
