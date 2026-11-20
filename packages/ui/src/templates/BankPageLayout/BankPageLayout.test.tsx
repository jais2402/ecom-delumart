import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BankPageLayout } from "./BankPageLayout";

describe("BankPageLayout", () => {
  it("wraps the panel in main with the in-game label", () => {
    render(
      <BankPageLayout>
        <h1>Panel</h1>
      </BankPageLayout>,
    );
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "Panel" }));
    expect(screen.getByText("In-game bank page · fictional money")).toBeInTheDocument();
  });
  it("keeps the panel narrow", () => {
    render(<BankPageLayout>x</BankPageLayout>);
    expect(screen.getByRole("main")).toHaveClass("max-w-md");
  });
});
