import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderGroupReview } from "./OrderGroupReview";

const groups = [
  {
    sellerId: "a",
    sellerName: "DeluluMart Originals",
    speedName: "Standard",
    itemNames: ["Monsoon in a Jar", "Pocket Comet"],
    deliveryFeePaise: 0n,
    totalPaise: 900_00n,
  },
  {
    sellerId: "b",
    sellerName: "Cloud Nine",
    speedName: "Express",
    itemNames: ["Tiffin Box"],
    deliveryFeePaise: 100_00n,
    totalPaise: 400_00n,
  },
];

describe("OrderGroupReview", () => {
  it("lists each seller group with its items, speed and fee, then the total", () => {
    render(<OrderGroupReview groups={groups} totalPaise={1_300_00n} />);
    const first = screen.getByRole("region", { name: "Sold by DeluluMart Originals" });
    expect(within(first).getByText("Pocket Comet")).toBeInTheDocument();
    expect(within(first).getByText("Free")).toBeInTheDocument();
    const second = screen.getByRole("region", { name: "Sold by Cloud Nine" });
    expect(within(second).getByText("Express")).toBeInTheDocument();
    expect(screen.getByText("Order total")).toBeInTheDocument();
  });
  it("has an accessible name for the whole list", () => {
    render(<OrderGroupReview groups={groups} totalPaise={1n} />);
    expect(screen.getByRole("region", { name: "Items in this order" })).toBeInTheDocument();
  });
});
