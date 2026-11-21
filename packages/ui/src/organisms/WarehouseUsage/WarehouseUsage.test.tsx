import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WarehouseUsage } from "./WarehouseUsage";

describe("WarehouseUsage", () => {
  it("states use in words and as a named progress bar", () => {
    render(<WarehouseUsage used={0} capacity={100} />);
    expect(screen.getByText("0 of 100 used")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Starter warehouse space used" });
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });
  it("reflects partial use", () => {
    render(<WarehouseUsage used={25} capacity={100} name="Main" />);
    expect(screen.getByText("25 of 100 used")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Main space used" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
  });
});
