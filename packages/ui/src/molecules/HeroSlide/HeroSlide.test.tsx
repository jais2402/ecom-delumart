import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HeroSlide } from "./HeroSlide";

const item = {
  id: "limo",
  href: "/p/limo",
  name: "Limousine Pulled by Eleven Swans",
  hook: "Arrives gracefully.",
  pricePaise: 250_000_000n,
  hue: 200,
  motif: "luxury" as const,
};

describe("HeroSlide", () => {
  it("shows the product's name as a heading, its hook and its price", () => {
    render(<HeroSlide item={item} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Limousine Pulled by Eleven Swans" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Arrives gracefully.")).toBeInTheDocument();
    expect(screen.getByText(/₹/)).toBeInTheDocument();
  });
  it("has a Shop now link to the product, named with the product so several stay distinguishable", async () => {
    render(<HeroSlide item={item} />);
    await userEvent.tab();
    const link = screen.getByRole("link", { name: "Shop now: Limousine Pulled by Eleven Swans" });
    expect(link).toHaveAttribute("href", "/p/limo");
    expect(link).toHaveFocus();
  });
  it("shows a photo as an eager same-origin image only when asked, with decorative alt text", () => {
    const { container, rerender } = render(<HeroSlide item={{ ...item, imageSrc: "/products/a.webp" }} />);
    expect(container.querySelector("img")).toHaveAttribute("loading", "lazy");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    rerender(<HeroSlide item={{ ...item, imageSrc: "/products/a.webp" }} eager />);
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
  });
  it("merges the class name", () => {
    const { container } = render(<HeroSlide item={item} className="x-test" />);
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
