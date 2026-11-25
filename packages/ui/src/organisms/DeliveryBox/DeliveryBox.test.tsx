import { render, screen } from "@testing-library/react";
import { Truck, Wallet } from "lucide-react";
import { describe, expect, it } from "vitest";
import { DeliveryBox } from "./DeliveryBox";

describe("DeliveryBox", () => {
  it("is a list with one row per promise, each with its text", () => {
    render(
      <DeliveryBox
        aria-label="Delivery"
        rows={[
          { icon: Truck, text: "Delivery is simulated.", status: "In stock", statusTone: "success" },
          { icon: Wallet, text: "Pay with fictional money only." },
        ]}
      />,
    );
    expect(screen.getByRole("list", { name: "Delivery" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Delivery is simulated.")).toBeInTheDocument();
  });
  it("shows the bold status line in green only for availability", () => {
    render(
      <DeliveryBox
        rows={[
          { icon: Truck, text: "a", status: "In stock", statusTone: "success" },
          { icon: Truck, text: "b", status: "Standard" },
        ]}
      />,
    );
    expect(screen.getByText("In stock")).toHaveClass("text-success", "font-bold");
    expect(screen.getByText("Standard")).not.toHaveClass("text-success");
  });
});
