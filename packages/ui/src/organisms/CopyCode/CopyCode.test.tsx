import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyCode } from "./CopyCode";

afterEach(() => vi.unstubAllGlobals());

describe("CopyCode", () => {
  it("shows the code and names the button after it", () => {
    render(<CopyCode code="SAVE10" />);
    expect(screen.getByText("SAVE10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy coupon code SAVE10" })).toBeInTheDocument();
  });
  it("copies and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopyCode code="SAVE10" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy coupon code/ }));
    expect(writeText).toHaveBeenCalledWith("SAVE10");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied to the clipboard.");
  });
  it("selects the text when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    render(<CopyCode code="SAVE10" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy coupon code/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("selected");
    expect(window.getSelection()?.toString()).toBe("SAVE10");
  });
});
