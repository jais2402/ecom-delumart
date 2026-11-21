import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeliveryChoice } from "./DeliveryChoice";

const options = [
  { value: "STANDARD", speedName: "Standard", arrival: "Arrives in about 24 hours", feePaise: 0n },
  { value: "EXPRESS", speedName: "Express", arrival: "Arrives in about 2 hours", feePaise: 150_00n },
  { value: "ZAP", speedName: "Zap", arrival: "Arrives in about 10 minutes", feePaise: null },
];

describe("DeliveryChoice", () => {
  it("is a group named after the seller with one radio per offered speed", () => {
    render(
      <DeliveryChoice
        sellerName="Cloud Nine"
        name="d-1"
        options={options}
        value="STANDARD"
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Delivery from Cloud Nine" });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Fee shown once chosen")).toBeInTheDocument();
  });
  it("reports the chosen speed", async () => {
    const onChange = vi.fn();
    render(
      <DeliveryChoice
        sellerName="Cloud Nine"
        name="d-2"
        options={options}
        value="STANDARD"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Express/ }));
    expect(onChange).toHaveBeenCalledWith("EXPRESS");
  });
});
