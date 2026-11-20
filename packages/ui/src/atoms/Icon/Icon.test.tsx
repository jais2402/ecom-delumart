import { render, screen } from "@testing-library/react";
import { Star } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("is aria-hidden by default", () => {
    const { container } = render(<Icon icon={Star} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
  it("exposes a role and name when labelled", () => {
    render(<Icon icon={Star} label="Favourite" />);
    expect(screen.getByRole("img", { name: "Favourite" })).toBeInTheDocument();
  });
  it("applies size", () => {
    const { container } = render(<Icon icon={Star} size={32} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "32");
  });
});
