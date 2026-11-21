import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShopHeader } from "./ShopHeader";

describe("ShopHeader", () => {
  it("is headed by the shop name and shows address, tier and description", () => {
    render(
      <ShopHeader displayName="Cloud Nine" handle="cloud-nine" tier="SOLO" description="Weather, bottled." />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Cloud Nine" })).toBeInTheDocument();
    expect(screen.getByText("/store/cloud-nine")).toBeInTheDocument();
    expect(screen.getByText("Solo shop")).toBeInTheDocument();
    expect(screen.getByText("Weather, bottled.")).toBeInTheDocument();
  });
  it("omits an empty description and the tier when not given", () => {
    render(<ShopHeader displayName="Cloud Nine" handle="cloud-nine" description="" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(screen.queryByText(/shop$/)).not.toBeInTheDocument();
  });
});
