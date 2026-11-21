import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CouponForm } from "./CouponForm";

describe("CouponForm", () => {
  it("is a named form with labelled fields", () => {
    render(<CouponForm onSubmit={() => {}} />);
    expect(screen.getByRole("form", { name: "New coupon" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Percent off/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Minimum spend/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Public code/)).not.toBeInTheDocument();
  });
  it("refuses a percent above 90 and a public code that is too short", async () => {
    const onSubmit = vi.fn();
    render(<CouponForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/^Percent off/), "95");
    await userEvent.click(screen.getByRole("radio", { name: /^Public/ }));
    await userEvent.type(screen.getByLabelText(/^Public code/), "ab");
    await userEvent.click(screen.getByRole("button", { name: "Create coupon" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Percent off/)).toHaveAccessibleDescription(/between 1 and 90/);
    expect(screen.getByLabelText(/^Public code/)).toHaveAccessibleDescription(/4 to 16/);
  });
  it("sends a private percent coupon without a code", async () => {
    const onSubmit = vi.fn();
    render(<CouponForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/^Percent off/), "10");
    await userEvent.click(screen.getByRole("button", { name: "Create coupon" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "PERCENT", value: 10, isPublic: false });
  });
  it("sends a public flat coupon with an upper-case code and minimum spend", async () => {
    const onSubmit = vi.fn();
    render(<CouponForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("radio", { name: "Flat rupee discount" }));
    await userEvent.type(screen.getByLabelText(/^Rupees off/), "200");
    await userEvent.type(screen.getByLabelText(/Minimum spend/), "1000");
    await userEvent.click(screen.getByRole("radio", { name: /^Public/ }));
    await userEvent.type(screen.getByLabelText(/^Public code/), "spring20");
    await userEvent.click(screen.getByRole("button", { name: "Create coupon" }));
    expect(onSubmit).toHaveBeenCalledWith({
      kind: "FLAT",
      value: 200,
      minSpendRupees: 1000,
      isPublic: true,
      publicCode: "SPRING20",
    });
  });
});
