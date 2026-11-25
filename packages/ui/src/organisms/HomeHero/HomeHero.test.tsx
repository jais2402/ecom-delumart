import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HomeHero } from "./HomeHero";

const tile = (n: number) => ({
  href: `/c/${n}`,
  caption: `Category ${n}`,
  detail: "From ₹100",
  hue: n * 40,
  seed: `s${n}`,
  motif: "tech" as const,
});
const props = {
  title: "Start with ₹100 crore.",
  text: "A pretend department store.",
  action: { label: "Shop now", href: "#featured" },
  tiles: [tile(1), tile(2), tile(3)],
};

describe("HomeHero", () => {
  it("has the page's one h1, one line of subcopy and one button in the colour block", () => {
    render(<HomeHero {...props} />);
    expect(screen.getByRole("heading", { level: 1, name: "Start with ₹100 crore." })).toBeInTheDocument();
    expect(screen.getByText("A pretend department store.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shop now" })).toHaveAttribute("href", "#featured");
  });
  it("makes each picture tile one link to its category, named by its caption", () => {
    render(<HomeHero {...props} />);
    const link = screen.getByRole("link", { name: /Category 2/ });
    expect(link).toHaveAttribute("href", "/c/2");
    expect(link).toHaveTextContent("From ₹100");
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });
  it("tabs through the button and then the tiles, with decorative art", async () => {
    render(<HomeHero {...props} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Shop now" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: /Category 1/ })).toHaveFocus();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("shows a photo tile as an eager same-origin image", () => {
    const { container } = render(
      <HomeHero {...props} tiles={[{ ...tile(1), imageSrc: "/products/a.webp" }]} />,
    );
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/products/a.webp");
    expect(img).toHaveAttribute("loading", "eager");
  });
});
