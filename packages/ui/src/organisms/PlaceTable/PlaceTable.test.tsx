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
  it("R7.1 (eighth review, minor 3b): a shown row's small sign-up or purchase cell reads 'Fewer than N' (the cell minimum)", () => {
    const small = [{ key: "IN", label: "India", visitors: 750, signUps: null, purchases: 9 }];
    render(
      <PlaceTable caption="Usage" placeHeader="Country" rows={small} minVisitors={10} minCellCount={5} />,
    );
    const india = screen.getByRole("row", { name: /India/ });
    const cells = within(india).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("Fewer than 5");
    expect(cells[2]).toHaveTextContent("9");
    expect(india).toHaveTextContent("750");
  });
  it("R7.1: a suppressed row shows 'Fewer than N' and no counts, and is left out of the shares", () => {
    const withSuppressed = [
      { key: "IN", label: "India", visitors: 750, signUps: 40, purchases: 9 },
      {
        key: "Other",
        label: "Other (small places combined)",
        visitors: null,
        signUps: null,
        purchases: null,
        suppressed: true,
      },
    ];
    render(<PlaceTable caption="Usage" placeHeader="Country" rows={withSuppressed} minVisitors={10} />);
    const other = screen.getByRole("row", { name: /Other/ });
    expect(other).toHaveTextContent("Fewer than 10");
    expect(within(other).getAllByText("Not shown")).toHaveLength(3);
    expect(other).not.toHaveTextContent("%");
    expect(screen.getByRole("row", { name: /India/ })).toHaveTextContent("100%");
    expect(screen.getAllByTestId("place-bar")).toHaveLength(1);
  });
  it("shows the empty state, and makes the scroll region focusable", () => {
    const { rerender } = render(<PlaceTable caption="Usage" placeHeader="Country" rows={rows} />);
    expect(screen.getByRole("region", { name: "Usage" })).toHaveAttribute("tabindex", "0");
    rerender(<PlaceTable caption="Usage" placeHeader="Country" rows={[]} />);
    expect(screen.getByRole("heading", { name: "No data for this period yet" })).toBeInTheDocument();
  });
});
