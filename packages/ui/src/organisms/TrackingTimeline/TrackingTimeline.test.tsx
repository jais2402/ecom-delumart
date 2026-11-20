import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrackingTimeline, type TrackingStage } from "./TrackingTimeline";

const stages: TrackingStage[] = [
  { key: "placed", title: "Order placed", state: "done", time: "9:00 am" },
  { key: "packed", title: "Packed", state: "done" },
  { key: "way", title: "On the way", state: "current", note: "Simulated courier" },
  { key: "near", title: "Nearby", state: "upcoming" },
  { key: "delivered", title: "Delivered", state: "upcoming" },
];

describe("TrackingTimeline", () => {
  it("renders five stages in an ordered list", () => {
    render(<TrackingTimeline stages={stages} />);
    expect(screen.getByRole("list", { name: "Order tracking" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });
  it("marks the current stage and states each stage in text", () => {
    render(<TrackingTimeline stages={stages} />);
    expect(screen.getByText(/On the way/).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/Order placed/).closest("li")).toHaveTextContent("Done:");
    expect(screen.getByText("Simulated courier")).toBeInTheDocument();
  });
});
