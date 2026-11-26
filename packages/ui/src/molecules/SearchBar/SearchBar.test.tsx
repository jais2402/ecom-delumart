import { render, screen, within } from "@testing-library/react";
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
  it("keeps its names and behaviour in the pill variant", async () => {
    const onSearch = vi.fn();
    render(<SearchBar variant="pill" onSearch={onSearch} />);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveClass("rounded-pill");
    await userEvent.type(screen.getByRole("searchbox"), "moon{Enter}");
    expect(onSearch).toHaveBeenCalledWith("moon");
  });

  describe("with suggestions (combobox)", () => {
    const suggestions = [
      { id: "a", label: "Monsoon in a jar", href: "/p/a", kind: "Product" },
      { id: "b", label: "Everyday Magic", href: "/c/everyday-magic", kind: "Department" },
    ] as const;

    it("is a combobox whose listbox opens as the shopper types and names its active row", async () => {
      render(<SearchBar variant="pill" onSearch={() => {}} suggestions={suggestions} />);
      const field = screen.getByRole("combobox", { name: "Search" });
      expect(field).toHaveAttribute("aria-expanded", "false");
      await userEvent.type(field, "mo");
      expect(field).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("listbox", { name: "Search suggestions" });
      expect(within(list).getAllByRole("option")).toHaveLength(2);
      await userEvent.keyboard("{ArrowDown}");
      const first = screen.getByRole("option", { name: /Monsoon in a jar/ });
      expect(first).toHaveAttribute("aria-selected", "true");
      expect(field).toHaveAttribute("aria-activedescendant", first.id);
      expect(field).toHaveFocus();
    });
    it("Enter on the active row goes to it and does not submit the plain search", async () => {
      const onSearch = vi.fn();
      const onSelect = vi.fn();
      render(<SearchBar onSearch={onSearch} suggestions={suggestions} onSelectSuggestion={onSelect} />);
      await userEvent.type(screen.getByRole("combobox"), "mo{ArrowDown}{ArrowDown}{Enter}");
      expect(onSelect).toHaveBeenCalledWith(suggestions[1]);
      expect(onSearch).not.toHaveBeenCalled();
    });
    it("Enter with no active row submits the plain search, and Escape closes the list", async () => {
      const onSearch = vi.fn();
      render(<SearchBar onSearch={onSearch} suggestions={suggestions} />);
      const field = screen.getByRole("combobox");
      await userEvent.type(field, "mo{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      expect(onSearch).toHaveBeenCalledWith("mo");
    });
    it("reports the query as it changes", async () => {
      const onQueryChange = vi.fn();
      render(<SearchBar onSearch={() => {}} suggestions={[]} onQueryChange={onQueryChange} />);
      await userEvent.type(screen.getByRole("combobox"), "ja");
      expect(onQueryChange).toHaveBeenLastCalledWith("ja");
    });
  });
});
