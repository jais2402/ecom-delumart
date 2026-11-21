import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignInPanel } from "./SignInPanel";

const noop = () => Promise.resolve();

describe("SignInPanel", () => {
  it("renders one h1, the Google button and a labelled email field", () => {
    render(<SignInPanel onGoogle={noop} onEmailSubmit={noop} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Email address/ })).toHaveAttribute("autocomplete", "email");
  });

  it("rejects an invalid email, ties the error to the field and does not submit", async () => {
    const onEmailSubmit = vi.fn(noop);
    render(<SignInPanel onGoogle={noop} onEmailSubmit={onEmailSubmit} />);
    const field = screen.getByRole("textbox", { name: /Email address/ });
    await userEvent.type(field, "not-an-email{Enter}");
    expect(onEmailSubmit).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByText(/Enter a valid email address/);
    expect(field.getAttribute("aria-describedby")).toContain(message.id);
  });

  it("submits a valid email with Enter", async () => {
    const onEmailSubmit = vi.fn(noop);
    render(<SignInPanel onGoogle={noop} onEmailSubmit={onEmailSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: /Email address/ }), "asha@example.com{Enter}");
    expect(onEmailSubmit).toHaveBeenCalledWith("asha@example.com");
  });

  it("calls onGoogle from the Google button", async () => {
    const onGoogle = vi.fn(noop);
    render(<SignInPanel onGoogle={onGoogle} onEmailSubmit={noop} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(onGoogle).toHaveBeenCalledOnce();
  });

  it("shows the check-your-inbox state and a server error", () => {
    const { rerender } = render(
      <SignInPanel onGoogle={noop} onEmailSubmit={noop} sentTo="asha@example.com" />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByText("asha@example.com")).toBeInTheDocument();
    rerender(<SignInPanel onGoogle={noop} onEmailSubmit={noop} error="Try again later." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Try again later.");
  });
  it("says no email is sent when the local development provider is active", () => {
    render(<SignInPanel onGoogle={noop} onEmailSubmit={noop} devMode />);
    expect(screen.getByText("Local development sign-in: no email is sent.")).toBeInTheDocument();
    expect(screen.queryByText(/We email you/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in locally" })).toBeInTheDocument();
  });
});
