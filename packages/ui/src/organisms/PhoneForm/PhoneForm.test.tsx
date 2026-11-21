import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhoneForm } from "./PhoneForm";

const noop = () => Promise.resolve();

describe("PhoneForm", () => {
  it("renders a labelled tel input with the fixed +91 prefix and the privacy note", () => {
    render(<PhoneForm onSubmit={noop} />);
    const field = screen.getByRole("textbox", { name: /Mobile number \(India\)/ });
    expect(field).toHaveAttribute("inputmode", "tel");
    expect(field).toHaveAttribute("autocomplete", "tel-national");
    expect(screen.getByTestId("country-code")).toHaveTextContent("+91");
    expect(
      screen.getByText("Used only to keep one account per person. No marketing messages."),
    ).toBeInTheDocument();
  });

  it("shows an inline error for an invalid number and does not submit", async () => {
    const onSubmit = vi.fn(noop);
    render(<PhoneForm onSubmit={onSubmit} />);
    const field = screen.getByRole("textbox", { name: /Mobile number/ });
    await userEvent.type(field, "1234{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    const message = screen.getByText(/Enter a valid 10-digit/);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(message.id);
  });

  it("submits E.164 on Enter, accepting spaces", async () => {
    const onSubmit = vi.fn(noop);
    render(<PhoneForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: /Mobile number/ }), "98765 43210{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("+919876543210");
  });
});
