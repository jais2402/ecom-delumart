import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PinSetupForm } from "./PinSetupForm";

const noop = () => Promise.resolve();
const BIRTHDATE = "2001-03-05";

describe("PinSetupForm", () => {
  it("shows the warning, two labelled PIN fields and the rule checklist", () => {
    render(<PinSetupForm onSubmit={noop} birthdate={BIRTHDATE} />);
    expect(
      screen.getByText("Game PIN only. Do not use the PIN of a real card or UPI app."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Game PIN")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText("Confirm game PIN")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "PIN rules" })).toBeInTheDocument();
  });

  it("explains a weak PIN in plain words and does not submit", async () => {
    const onSubmit = vi.fn(noop);
    render(<PinSetupForm onSubmit={onSubmit} birthdate={BIRTHDATE} />);
    await userEvent.type(screen.getByLabelText("Game PIN"), "123456");
    await userEvent.type(screen.getByLabelText("Confirm game PIN"), "123456{Enter}");
    expect(screen.getByText(/That is a sequence/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects a PIN built from the birthdate", async () => {
    render(<PinSetupForm onSubmit={noop} birthdate={BIRTHDATE} />);
    await userEvent.type(screen.getByLabelText("Game PIN"), "050301");
    expect(screen.getByText(/made from your birthdate/)).toBeInTheDocument();
  });

  it("flags a mismatch, then submits a strong matching PIN on Enter", async () => {
    const onSubmit = vi.fn(noop);
    render(<PinSetupForm onSubmit={onSubmit} birthdate={BIRTHDATE} />);
    await userEvent.type(screen.getByLabelText("Game PIN"), "482915");
    await userEvent.type(screen.getByLabelText("Confirm game PIN"), "482916");
    expect(screen.getByText("The two PINs do not match.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Confirm game PIN"));
    await userEvent.type(screen.getByLabelText("Confirm game PIN"), "482915{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("482915");
  });

  it("takes a custom title, heading level and button label (for use inside another page)", () => {
    render(
      <PinSetupForm
        onSubmit={noop}
        birthdate={BIRTHDATE}
        title="Change your game PIN"
        headingLevel={2}
        submitLabel="Change PIN"
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Change your game PIN" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change PIN" })).toBeInTheDocument();
  });
});
