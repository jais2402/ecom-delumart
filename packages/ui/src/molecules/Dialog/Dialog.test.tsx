import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";

describe("Dialog", () => {
  it("opens from the trigger with a titled, described dialog", async () => {
    render(
      <Dialog
        trigger={<button type="button">Open</button>}
        title="Confirm order"
        description="Pay with fictional money"
      >
        Body
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm order" });
    expect(dialog).toHaveAccessibleDescription("Pay with fictional money");
    expect(dialog).toHaveTextContent("Body");
  });
  it("closes with the labelled close button and restores focus", async () => {
    render(
      <Dialog trigger={<button type="button">Open</button>} title="T">
        Body
      </Dialog>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });
  it("closes on Escape and supports a custom close label", async () => {
    render(<Dialog defaultOpen title="T" closeLabel="Dismiss" />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
