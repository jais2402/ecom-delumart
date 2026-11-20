import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CheckoutLayout } from "./CheckoutLayout";

function setup() {
  render(
    <CheckoutLayout
      header={<header>H</header>}
      footer={<footer>F</footer>}
      steps={<nav aria-label="Checkout progress">Steps</nav>}
      summary={<p>Summary text</p>}
    >
      <h1>Delivery</h1>
    </CheckoutLayout>,
  );
}

describe("CheckoutLayout", () => {
  it("shows steps, content and summary inside main", () => {
    setup();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("navigation", { name: "Checkout progress" })).toBeInTheDocument();
    expect(within(main).getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    expect(within(main).getByText("Summary text")).toBeInTheDocument();
  });
  it("labels the summary aside and stacks it on small screens", () => {
    setup();
    const aside = screen.getByRole("complementary", { name: "Your order" });
    expect(aside.parentElement).toHaveClass("lg:grid-cols-[minmax(0,1fr)_22rem]");
    expect(aside.parentElement).not.toHaveClass("grid-cols-2");
  });
});
