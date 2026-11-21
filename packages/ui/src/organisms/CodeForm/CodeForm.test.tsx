import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeForm } from "./CodeForm";

const noop = () => Promise.resolve();

afterEach(() => vi.useRealTimers());

describe("CodeForm", () => {
  it("renders a labelled one-time-code input", () => {
    render(<CodeForm onSubmit={noop} onResend={noop} />);
    const field = screen.getByRole("textbox", { name: /6-digit verification code/ });
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    expect(field).toHaveAttribute("inputmode", "numeric");
  });

  it("keeps only digits, rejects a short code and submits six digits on Enter", async () => {
    const onSubmit = vi.fn(noop);
    render(<CodeForm onSubmit={onSubmit} onResend={noop} />);
    const field = screen.getByRole("textbox", { name: /verification code/ });
    await userEvent.type(field, "12a3{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field).toHaveValue("123");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toContain(screen.getByText(/Enter the 6-digit code/).id);
    await userEvent.type(field, "456{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("123456");
  });

  it("disables resend with a visible countdown, then enables it", () => {
    vi.useFakeTimers();
    render(<CodeForm onSubmit={noop} onResend={noop} resendSeconds={30} />);
    const resend = screen.getByRole("button", { name: "Resend code" });
    expect(resend).toBeDisabled();
    expect(screen.getByText("You can ask for a new code in 30s.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("You can request a new code in 30 seconds.");
    for (let i = 0; i < 30; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resend).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("You can request a new code now.");
  });

  it("shows a server error in an alert", () => {
    render(<CodeForm onSubmit={noop} onResend={noop} error="That code is not right." />);
    expect(screen.getByRole("alert")).toHaveTextContent("That code is not right.");
  });
});
