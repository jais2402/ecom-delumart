import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("renders with its accessible name and fires onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to cart</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("is busy and not clickable while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Pay
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Pay" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
  it("renders as its child with asChild", () => {
    render(
      <Button asChild variant="secondary">
        <a href="/shop">Shop</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Shop" })).toHaveAttribute("href", "/shop");
  });
  it("defaults to type=button and applies variant classes", () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("bg-danger", "min-h-touch");
  });
});
