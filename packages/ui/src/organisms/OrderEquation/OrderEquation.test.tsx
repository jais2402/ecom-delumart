import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderEquation } from "./OrderEquation";

const props = { listPaise: 100_000n, discountPaise: 10_000n, feePaise: 4_500n, deliverySellerPaise: 0n };

describe("OrderEquation", () => {
  it("shows gross and net as small equations that add up", () => {
    render(<OrderEquation {...props} />);
    expect(screen.getByTestId("equation-gross")).toHaveTextContent("equals gross ₹900");
    expect(screen.getByTestId("equation-net")).toHaveTextContent("equals net ₹855");
  });
  it("subtracts delivery the seller paid", () => {
    render(<OrderEquation {...props} deliverySellerPaise={5_000n} />);
    expect(screen.getByTestId("equation-net")).toHaveTextContent("equals net ₹805");
  });
  it("has a spoken name for each equation", () => {
    render(<OrderEquation {...props} />);
    expect(screen.getByText(/equals net ₹855/)).toHaveClass("sr-only");
  });
});
