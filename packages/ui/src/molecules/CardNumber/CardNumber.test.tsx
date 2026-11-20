import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CardNumber } from "./CardNumber";

describe("CardNumber", () => {
  it("is masked by default, showing only the last four", () => {
    render(<CardNumber number="4111111111114242" />);
    expect(screen.getByText("•••• •••• •••• 4242")).toBeInTheDocument();
    expect(screen.queryByText("4111 1111 1111 4242")).toBeNull();
    expect(screen.getByText("Card number ending in 4242")).toBeInTheDocument();
  });
  it("reveals grouped digits and hides again", async () => {
    render(<CardNumber number="4111111111114242" />);
    await userEvent.click(screen.getByRole("button", { name: "Reveal card number" }));
    expect(screen.getByText("4111 1111 1111 4242")).toHaveClass("font-mono");
    await userEvent.click(screen.getByRole("button", { name: "Hide card number" }));
    expect(screen.queryByText("4111 1111 1111 4242")).toBeNull();
  });
  it("has no input for typing a card number and exposes pressed state", () => {
    render(<CardNumber number="4111111111114242" />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });
});
