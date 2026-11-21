import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlaceTable } from "./PlaceTable";

const rows = [
  { key: "IN", label: "India", visitors: 750, signUps: 40, purchases: 9, drillable: true },
  { key: "Other", label: "Other (small places combined)", visitors: 250, signUps: 2, purchases: 0 },
];

describe("PlaceTable", () => {
  it("renders a named table with a proportional bar and share per row", () => {
    render(<PlaceTable caption="Usage by country" placeHeader="Country" rows={rows} />);
    const table = screen.getByRole("table", { name: "Usage by country" });
    expect(within(table).getByRole("columnheader", { name: "Daily visitors (summed)" })).toBeInTheDocument();
    const india = within(table).getByRole("row", { name: /India/ });
    expect(india).toHaveTextContent("750");
    expect(india).toHaveTextContent("75%");
    expect(screen.getAllByTestId("place-bar").map((b) => b.style.width)).toEqual(["75%", "25%"]);
  });
  it("drills only on drillable rows, through a button with an accessible name", async () => {
    const onDrill = vi.fn();
    render(<PlaceTable caption="Usage" placeHeader="Country" rows={rows} onDrill={onDrill} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Show places in India" }));
    expect(onDrill).toHaveBeenCalledWith(rows[0]);
  });
  it("shows the empty state, and makes the scroll region focusable", () => {
    const { rerender } = render(<PlaceTable caption="Usage" placeHeader="Country" rows={rows} />);
    expect(screen.getByRole("region", { name: "Usage" })).toHaveAttribute("tabindex", "0");
    rerender(<PlaceTable caption="Usage" placeHeader="Country" rows={[]} />);
    expect(screen.getByRole("heading", { name: "No data for this period yet" })).toBeInTheDocument();
  });
});
