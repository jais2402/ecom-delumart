import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CouponInput } from "./CouponInput";

describe("CouponInput", () => {
  it("applies the typed code", async () => {
    const onApply = vi.fn();
    render(<CouponInput onApply={onApply} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Coupon code" }), "DREAM10");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith("DREAM10");
  });
  it("does not apply an empty code", async () => {
    const onApply = vi.fn();
    render(<CouponInput onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).not.toHaveBeenCalled();
  });
  it("shows the applied state with a remove button", async () => {
    const onRemove = vi.fn();
    render(<CouponInput onApply={() => {}} onRemove={onRemove} appliedCode="DREAM10" />);
    expect(screen.getByText("DREAM10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Remove coupon DREAM10/ }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
  it("links error text to the input", () => {
    render(<CouponInput onApply={() => {}} error="Code expired" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Code expired");
  });
});
