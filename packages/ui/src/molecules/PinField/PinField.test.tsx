import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PinField } from "./PinField";

describe("PinField", () => {
  it("has the game-only label and hint", () => {
    render(<PinField />);
    const input = screen.getByLabelText("Delulu PIN (game only)");
    expect(input).toHaveAccessibleDescription("Do not use the PIN of a real card or UPI app");
  });
  it("opts out of saving and uses numeric six-digit input", () => {
    render(<PinField />);
    const input = screen.getByLabelText("Delulu PIN (game only)");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("maxlength", "6");
  });
  it("accepts only digits, at most six", async () => {
    render(<PinField />);
    const input = screen.getByLabelText("Delulu PIN (game only)");
    await userEvent.type(input, "12ab3456789");
    expect(input).toHaveValue("123456");
  });
  it("describes an error and marks invalid", () => {
    render(<PinField error="Wrong PIN" />);
    const input = screen.getByLabelText("Delulu PIN (game only)");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Wrong PIN/);
  });
});
