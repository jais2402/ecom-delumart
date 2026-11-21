import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppealForm } from "./AppealForm";

describe("AppealForm", () => {
  it("has a labelled statement field and a counter", () => {
    render(<AppealForm onSubmit={() => {}} />);
    expect(screen.getByLabelText(/Why should we look again/)).toBeInTheDocument();
    expect(screen.getByText(/0 of 1000 characters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send appeal" })).toBeInTheDocument();
  });
  it("refuses a short statement and sends a long enough one", async () => {
    const onSubmit = vi.fn();
    render(<AppealForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/Why should we look again/), "too short");
    await userEvent.click(screen.getByRole("button", { name: "Send appeal" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Why should we look again/)).toHaveAccessibleDescription(
      /Write at least 20/,
    );
    await userEvent.type(screen.getByLabelText(/Why should we look again/), " and then it got longer");
    await userEvent.click(screen.getByRole("button", { name: "Send appeal" }));
    expect(onSubmit).toHaveBeenCalledWith("too short and then it got longer");
  });
});
