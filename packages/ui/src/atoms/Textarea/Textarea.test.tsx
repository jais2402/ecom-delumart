import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Textarea } from "./Textarea";

describe("Textarea", () => {
  it("is a textbox with an accessible name", () => {
    render(<Textarea aria-label="Review" />);
    expect(screen.getByRole("textbox", { name: "Review" })).toBeInTheDocument();
  });
  it("accepts typing", async () => {
    render(<Textarea aria-label="Review" />);
    await userEvent.type(screen.getByRole("textbox"), "great");
    expect(screen.getByRole("textbox")).toHaveValue("great");
  });
  it("sets aria-invalid when invalid", () => {
    render(<Textarea aria-label="Review" invalid />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });
});
