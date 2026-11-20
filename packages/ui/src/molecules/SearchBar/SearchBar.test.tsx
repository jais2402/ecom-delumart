import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("renders a search landmark with a labelled input", () => {
    render(<SearchBar onSearch={() => {}} />);
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
  });
  it("submits the trimmed query on Enter", async () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} />);
    await userEvent.type(screen.getByRole("searchbox"), "  teapot  {Enter}");
    expect(onSearch).toHaveBeenCalledWith("teapot");
  });
  it("submits with the button", async () => {
    const onSearch = vi.fn();
    render(<SearchBar onSearch={onSearch} defaultValue="lamp" />);
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearch).toHaveBeenCalledWith("lamp");
  });
});
