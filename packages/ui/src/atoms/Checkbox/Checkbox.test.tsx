import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("renders with its label as accessible name", () => {
    render(<Checkbox label="Gift wrap" />);
    expect(screen.getByRole("checkbox", { name: "Gift wrap" })).toBeInTheDocument();
  });
  it("toggles on click", async () => {
    render(<Checkbox label="Gift wrap" />);
    await userEvent.click(screen.getByLabelText("Gift wrap"));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
  it("exposes aria-invalid and disabled state", () => {
    render(<Checkbox label="Terms" invalid disabled />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toBeDisabled();
  });
});
