import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RevealableCard } from "./RevealableCard";

describe("RevealableCard", () => {
  it("renders masked, with only the last four digits and an accessible region name", () => {
    render(<RevealableCard holderName="Asha Rao" lastFour="1234" onReveal={() => {}} onHide={() => {}} />);
    expect(screen.getByRole("region", { name: "Delulu Card" })).toBeInTheDocument();
    expect(screen.getByText("Card number ending in 1234")).toBeInTheDocument();
    expect(screen.getByText("VIRTUAL · DELULUMART ONLY")).toBeInTheDocument();
  });
  it("asks the page to reveal, and shows the number the page passes in", async () => {
    const onReveal = vi.fn();
    const { rerender } = render(
      <RevealableCard holderName="Asha Rao" lastFour="1234" onReveal={onReveal} onHide={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reveal card number" }));
    expect(onReveal).toHaveBeenCalledTimes(1);
    rerender(
      <RevealableCard
        holderName="Asha Rao"
        lastFour="1234"
        number="9000000000001234"
        onReveal={onReveal}
        onHide={() => {}}
      />,
    );
    expect(screen.getByText("9000 0000 0000 1234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide card number" })).toHaveAttribute("aria-pressed", "true");
  });
  it("hides again through onHide and states the frozen state in text and name", async () => {
    const onHide = vi.fn();
    render(
      <RevealableCard
        holderName="Asha Rao"
        lastFour="1234"
        number="9000000000001234"
        frozen
        onReveal={() => {}}
        onHide={onHide}
      />,
    );
    expect(screen.getByRole("region", { name: "Delulu Card, frozen" })).toBeInTheDocument();
    expect(screen.getByText("Frozen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide card number" }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
