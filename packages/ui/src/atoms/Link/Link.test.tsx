import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Link } from "./Link";

describe("Link", () => {
  it("renders a link with name and href", () => {
    render(<Link href="/orders">Your orders</Link>);
    expect(screen.getByRole("link", { name: "Your orders" })).toHaveAttribute("href", "/orders");
  });
  it("merges className", () => {
    render(
      <Link href="/" className="extra">
        Home
      </Link>,
    );
    expect(screen.getByRole("link")).toHaveClass("extra", "text-action");
  });
  it("is keyboard focusable", () => {
    render(<Link href="/">Home</Link>);
    screen.getByRole("link").focus();
    expect(screen.getByRole("link")).toHaveFocus();
  });
});
