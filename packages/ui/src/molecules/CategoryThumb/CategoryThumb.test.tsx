import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CategoryThumb } from "./CategoryThumb";

const props = {
  name: "Impossible Tech",
  href: "/c/impossible-tech",
  motif: "tech",
  hue: 200,
  seed: "x",
} as const;

describe("CategoryThumb", () => {
  it("is one link named after the category, with the picture decorative", () => {
    render(<CategoryThumb {...props} />);
    const link = screen.getByRole("link", { name: "Impossible Tech" });
    expect(link).toHaveAttribute("href", "/c/impossible-tech");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("takes keyboard focus and can show a photo", async () => {
    const { container } = render(<CategoryThumb {...props} imageSrc="/products/a.webp" />);
    await userEvent.tab();
    expect(screen.getByRole("link")).toHaveFocus();
    expect(container.querySelector("img")).toHaveAttribute("src", "/products/a.webp");
  });
  it("draws a small light tile with a soft corner and the name centred beneath", () => {
    const { container } = render(<CategoryThumb {...props} />);
    const tile = container.querySelector("span");
    expect(tile).toHaveClass("size-24", "bg-surface-raised", "rounded-xl");
    expect(screen.getByText("Impossible Tech")).toHaveClass("text-center");
  });
});
