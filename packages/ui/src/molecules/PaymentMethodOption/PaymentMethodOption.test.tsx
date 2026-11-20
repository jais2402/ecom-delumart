import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PaymentMethodOption } from "./PaymentMethodOption";

describe("PaymentMethodOption", () => {
  it("is a radio named by the method", () => {
    render(
      <PaymentMethodOption
        name="p"
        value="wallet"
        methodName="Delulu Wallet"
        description="Pay from balance"
      />,
    );
    expect(screen.getByRole("radio", { name: /Delulu Wallet/ })).toBeInTheDocument();
  });
  it("selects on click", async () => {
    render(<PaymentMethodOption name="p" value="wallet" methodName="Delulu Wallet" />);
    await userEvent.click(screen.getByText("Delulu Wallet"));
    expect(screen.getByRole("radio")).toBeChecked();
  });
  it("is disabled with the reason described", () => {
    render(<PaymentMethodOption name="p" value="card" methodName="Card" disabledReason="Balance too low" />);
    const radio = screen.getByRole("radio");
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription("Balance too low");
  });
});
