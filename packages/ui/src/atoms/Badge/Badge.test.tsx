import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders its text", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });
  it.each([
    ["success", "bg-success-soft"],
    ["warning", "bg-warning-soft"],
    ["danger", "bg-danger-soft"],
    ["info", "bg-info-soft"],
    ["highlight", "bg-highlight"],
    ["neutral", "bg-surface-raised"],
  ] as const)("applies the %s tone", (tone, cls) => {
    render(<Badge tone={tone}>t</Badge>);
    expect(screen.getByText("t")).toHaveClass(cls);
  });
  it("conveys meaning through text, not colour alone", () => {
    render(<Badge tone="danger">Sold out</Badge>);
    expect(screen.getByText("Sold out")).toBeVisible();
  });
});
