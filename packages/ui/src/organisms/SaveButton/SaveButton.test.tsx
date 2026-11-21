import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SaveButton } from "./SaveButton";

describe("SaveButton", () => {
  it("is named for what pressing it does", () => {
    const { rerender } = render(
      <SaveButton productName="Monsoon in a Jar" saved={false} onToggle={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Save Monsoon in a Jar" })).toHaveAttribute(
      "data-saved",
      "false",
    );
    rerender(<SaveButton productName="Monsoon in a Jar" saved onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove Monsoon in a Jar from saved" })).toHaveAttribute(
      "data-saved",
      "true",
    );
  });
  it("calls onToggle on click and on keyboard activation", async () => {
    const onToggle = vi.fn();
    render(<SaveButton productName="Jar" saved={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button", { name: "Save Jar" }));
    screen.getByRole("button", { name: "Save Jar" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
