import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VirtualCard } from "./VirtualCard";

describe("VirtualCard", () => {
  it("shows the bank, holder and restriction line", () => {
    render(<VirtualCard holderName="Asha Rao" number="4111 1111 1111 1234" />);
    expect(screen.getByRole("region", { name: "Virtual card" })).toBeInTheDocument();
    expect(screen.getByText("Delulu Bank")).toBeInTheDocument();
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("VIRTUAL · DELULUMART ONLY")).toBeInTheDocument();
  });
  it("masks the number until revealed", async () => {
    render(<VirtualCard holderName="Asha Rao" number="4111111111111234" />);
    expect(screen.getByText("Card number ending in 1234")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reveal card number" }));
    expect(screen.getByText("4111 1111 1111 1234")).toBeInTheDocument();
  });
  it("states the frozen state in text and in the region name", () => {
    render(<VirtualCard holderName="Asha Rao" number="4111111111111234" frozen />);
    expect(screen.getByText("Frozen")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Virtual card, frozen" })).toBeInTheDocument();
  });
});
