import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnlockCelebration } from "./UnlockCelebration";

describe("UnlockCelebration", () => {
  it("is a named region with the opening copy and the route that unlocked it", () => {
    render(
      <UnlockCelebration
        routeText="You earned it with the Inventor Passport."
        onDismiss={() => {}}
        action={<a href="/sell/register">Register your shop</a>}
      />,
    );
    expect(screen.getByRole("region", { name: "Creator studio unlocked" })).toBeInTheDocument();
    expect(screen.getByText("Your creator studio is open.")).toBeInTheDocument();
    expect(screen.getByText("Keep shopping or build something impossible.")).toBeInTheDocument();
    expect(screen.getByText("You earned it with the Inventor Passport.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Register your shop" })).toBeInTheDocument();
  });
  it("can be dismissed", async () => {
    const onDismiss = vi.fn();
    render(<UnlockCelebration routeText="x" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
