import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DecisionForm } from "./DecisionForm";

const options = [
  { value: "UPHELD", label: "Uphold" },
  { value: "DISMISSED", label: "Dismiss", variant: "secondary" as const },
] as const;

describe("DecisionForm", () => {
  it("renders a named form with a labelled reason and one button per outcome", () => {
    render(<DecisionForm label="Decision on case 1" options={options} onDecide={() => {}} />);
    expect(screen.getByRole("form", { name: "Decision on case 1" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uphold: Decision on case 1" })).toBeInTheDocument();
  });
  it("needs a reason before it decides, then sends outcome and reason", async () => {
    const onDecide = vi.fn();
    render(<DecisionForm label="Decision on case 1" options={options} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Reason/)).toHaveAccessibleDescription(/at least 5 characters/);
    await userEvent.type(screen.getByLabelText(/Reason/), "Not against the rules.");
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(onDecide).toHaveBeenCalledWith("DISMISSED", "Not against the rules.");
  });
});
