import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Input } from "./Input";

describe("Input", () => {
  it("is a textbox with an accessible name", () => {
    render(<Input aria-label="Email" />);
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });
  it("accepts typing and respects disabled", async () => {
    const { rerender } = render(<Input aria-label="Email" />);
    await userEvent.type(screen.getByRole("textbox"), "hi");
    expect(screen.getByRole("textbox")).toHaveValue("hi");
    rerender(<Input aria-label="Email" disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
  it("sets aria-invalid when invalid", () => {
    render(<Input aria-label="Email" invalid />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });
});
