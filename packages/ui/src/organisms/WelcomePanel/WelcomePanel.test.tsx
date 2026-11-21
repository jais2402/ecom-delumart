import { STARTING_GRANT_PAISE } from "@delulu/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WelcomePanel } from "./WelcomePanel";

describe("WelcomePanel", () => {
  it("shows the fictional balance, a masked card and a link to start shopping", () => {
    render(<WelcomePanel balancePaise={STARTING_GRANT_PAISE} cardNumber="9000000012345670" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome to DeluluMart");
    expect(screen.getByText("₹100 crore · fictional money")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your Delulu Card" })).toBeInTheDocument();
    expect(screen.getByText("Card number ending in 5670")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start shopping" })).toHaveAttribute("href", "/");
  });

  it("keeps the number hidden until the player reveals it", async () => {
    render(<WelcomePanel balancePaise={STARTING_GRANT_PAISE} cardNumber="9000000012345670" />);
    expect(screen.queryByText("9000 0000 1234 5670")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reveal card number" }));
    expect(screen.getByText("9000 0000 1234 5670")).toBeInTheDocument();
  });
});
