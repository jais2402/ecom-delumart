import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelineItem } from "./TimelineItem";

function renderItem(ui: React.ReactElement) {
  return render(<ol>{ui}</ol>);
}

describe("TimelineItem", () => {
  it("renders title and time", () => {
    renderItem(<TimelineItem title="Packed" time="Tue, 9:30 am" dateTime="2026-11-17T09:30" state="done" />);
    expect(screen.getByRole("listitem")).toHaveTextContent("Packed");
    expect(screen.getByText("Tue, 9:30 am")).toHaveAttribute("datetime", "2026-11-17T09:30");
  });
  it("marks the current item with aria-current=step", () => {
    renderItem(<TimelineItem title="Out for delivery" state="current" />);
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "step");
  });
  it("states its status in text for each state", () => {
    renderItem(<TimelineItem title="Delivered" state="upcoming" />);
    expect(screen.getByText("Upcoming:")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).not.toHaveAttribute("aria-current");
  });
});
