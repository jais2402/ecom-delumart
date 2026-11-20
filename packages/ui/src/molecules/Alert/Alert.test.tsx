import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "./Alert";

describe("Alert", () => {
  it("uses role=alert for danger", () => {
    render(<Alert tone="danger" title="Payment failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Payment failed");
  });
  it.each(["info", "success", "warning"] as const)("uses role=status for %s", (tone) => {
    render(<Alert tone={tone}>Heads up</Alert>);
    expect(screen.getByRole("status")).toHaveTextContent("Heads up");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("hides the decorative icon from assistive tech", () => {
    const { container } = render(<Alert>Hi</Alert>);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
