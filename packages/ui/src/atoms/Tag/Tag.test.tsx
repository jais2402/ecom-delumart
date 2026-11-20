import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tag } from "./Tag";

describe("Tag", () => {
  it("renders its text", () => {
    render(<Tag>Gadgets</Tag>);
    expect(screen.getByText("Gadgets")).toBeInTheDocument();
  });
  it("calls onRemove from the remove button", async () => {
    const onRemove = vi.fn();
    render(
      <Tag onRemove={onRemove} removeLabel="Remove Gadgets">
        Gadgets
      </Tag>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Gadgets" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
  it("has no button when not removable", () => {
    render(<Tag>Plain</Tag>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
