import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddressCard } from "./AddressCard";

describe("AddressCard", () => {
  it("shows label, text and a fictional tag", () => {
    render(<AddressCard label="Home" text="Teacup Terrace, Cloud Nine Heights" kind="fictional" />);
    expect(screen.getByRole("article", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Teacup Terrace, Cloud Nine Heights")).toBeInTheDocument();
    expect(screen.getByText("Fictional spot")).toBeInTheDocument();
  });
  it("labels a real address", () => {
    render(<AddressCard label="Work" text="somewhere" kind="real" />);
    expect(screen.getByText("Real address")).toBeInTheDocument();
  });
  it("calls edit and delete with buttons named after the address", async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<AddressCard label="Home" text="t" kind="fictional" onEdit={onEdit} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Home" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Home" }));
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });
});
