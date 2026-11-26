import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CollapsibleBlock } from "./CollapsibleBlock";

describe("CollapsibleBlock", () => {
  it("renders a named toggle, closed by default, with the content in the page once", () => {
    render(
      <CollapsibleBlock title="Order summary" hint="₹10">
        <p>Totals</p>
      </CollapsibleBlock>,
    );
    const toggle = screen.getByRole("button", { name: /Order summary/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByText("Totals")).toHaveLength(1);
  });
  it("opens and closes with the keyboard", async () => {
    render(
      <CollapsibleBlock title="Order summary">
        <p>Totals</p>
      </CollapsibleBlock>,
    );
    const toggle = screen.getByRole("button", { name: "Order summary" });
    await userEvent.tab();
    expect(toggle).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).not.toHaveClass("hidden");
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
