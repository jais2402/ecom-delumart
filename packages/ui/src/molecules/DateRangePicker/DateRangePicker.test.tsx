import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateRangePicker } from "./DateRangePicker";

const base = { today: "2026-11-21", from: "2026-10-23", to: "2026-11-21" };

describe("DateRangePicker", () => {
  it("renders a named group with presets, marking the one that matches", () => {
    render(<DateRangePicker {...base} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Date range (UTC days)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Last 7 days" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("From")).toHaveValue("2026-10-23");
    expect(screen.getByLabelText("To")).toHaveValue("2026-11-21");
  });
  it("a preset ends today and starts N-1 days earlier", async () => {
    const onChange = vi.fn();
    render(<DateRangePicker {...base} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-11-15", to: "2026-11-21" });
  });
  it("applies a valid custom range", async () => {
    const onChange = vi.fn();
    render(<DateRangePicker {...base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-10" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-11-01", to: "2026-11-10" });
  });
  it("refuses a reversed, future or too long range with a message", async () => {
    const onChange = vi.fn();
    render(<DateRangePicker {...base} onChange={onChange} maxDays={30} />);
    const apply = screen.getByRole("button", { name: "Apply dates" });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-01" } });
    await userEvent.click(apply);
    expect(screen.getByRole("alert")).toHaveTextContent("on or before");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-30" } });
    await userEvent.click(apply);
    expect(screen.getByRole("alert")).toHaveTextContent("future");
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-21" } });
    await userEvent.click(apply);
    expect(screen.getByRole("alert")).toHaveTextContent("at most 30 days");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("follows the range when the parent changes it", () => {
    const { rerender } = render(<DateRangePicker {...base} onChange={() => {}} />);
    rerender(<DateRangePicker {...base} from="2026-11-15" onChange={() => {}} />);
    expect(screen.getByLabelText("From")).toHaveValue("2026-11-15");
  });
});
