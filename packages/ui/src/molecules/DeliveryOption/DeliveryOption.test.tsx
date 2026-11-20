import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DeliveryOption } from "./DeliveryOption";

describe("DeliveryOption", () => {
  it("is a radio named by speed and arrival", () => {
    render(<DeliveryOption name="d" value="fast" speedName="Express" arrival="Arrives Tuesday" />);
    expect(screen.getByRole("radio", { name: /Express/ })).toHaveAccessibleName(/Arrives Tuesday/);
  });
  it("selects on click", async () => {
    render(<DeliveryOption name="d" value="fast" speedName="Express" arrival="Tomorrow" />);
    await userEvent.click(screen.getByText("Express"));
    expect(screen.getByRole("radio")).toBeChecked();
  });
  it("shows Free with no fee and a Price with a fee", () => {
    const { rerender } = render(<DeliveryOption name="d" value="a" speedName="Std" arrival="Soon" />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    rerender(<DeliveryOption name="d" value="a" speedName="Std" arrival="Soon" feePaise={4_900n} />);
    expect(screen.queryByText("Free")).toBeNull();
    expect(screen.getByText(/fictional rupees/)).toBeInTheDocument();
  });
});
