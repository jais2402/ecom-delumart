import { render, screen } from "@testing-library/react";
import { Lock, Truck } from "lucide-react";
import { describe, expect, it } from "vitest";
import { TrustStrip } from "./TrustStrip";

const items = [
  { icon: Lock, title: "Never enter a real card", text: "Nothing here takes one." },
  { icon: Truck, title: "Delivery is simulated", text: "No parcel moves." },
];

describe("TrustStrip", () => {
  it("is a labelled list with one item per reassurance", () => {
    render(<TrustStrip items={items} label="Good to know" />);
    expect(screen.getByRole("list", { name: "Good to know" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Never enter a real card")).toBeInTheDocument();
  });
  it("merges the class name", () => {
    render(<TrustStrip items={items} className="x-test" />);
    expect(screen.getByRole("list")).toHaveClass("x-test");
  });
});
