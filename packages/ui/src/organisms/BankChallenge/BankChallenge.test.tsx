import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BankChallenge } from "./BankChallenge";

function setup(props = {}) {
  const onPay = vi.fn();
  const onCancel = vi.fn();
  render(
    <BankChallenge
      amountPaise={5_000_00n}
      cardAlias="Everyday card"
      onPay={onPay}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onPay, onCancel };
}

describe("BankChallenge", () => {
  it("is named SecureCheck, shows the alias and the in-game line", () => {
    setup();
    expect(screen.getByRole("form", { name: "Delulu Bank SecureCheck" })).toBeInTheDocument();
    expect(screen.getByText("Everyday card")).toBeInTheDocument();
    expect(screen.getByText("In-game payment · fictional money")).toBeInTheDocument();
  });
  it("enables Pay only for six digits and passes them on", async () => {
    const { onPay } = setup();
    const pay = screen.getByRole("button", { name: "Pay" });
    expect(pay).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Delulu PIN (game only)"), "123456");
    expect(pay).toBeEnabled();
    await userEvent.click(pay);
    expect(onPay).toHaveBeenCalledWith("123456");
  });
  it("cancels, and supports the code method", async () => {
    const { onCancel } = setup({ method: "code" });
    await userEvent.type(screen.getByLabelText(/SecureCheck code/), "12ab34");
    expect(screen.getByLabelText(/SecureCheck code/)).toHaveValue("1234");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
  it("never asks for card number, expiry or CVV", () => {
    setup();
    expect(screen.queryByLabelText(/card number|expiry|cvv/i)).not.toBeInTheDocument();
  });
});
