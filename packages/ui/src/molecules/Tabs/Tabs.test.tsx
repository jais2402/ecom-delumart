import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

function Example() {
  return (
    <Tabs defaultValue="a">
      <TabsList aria-label="Sections">
        <TabsTrigger value="a">Details</TabsTrigger>
        <TabsTrigger value="b">Reviews</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Details panel</TabsContent>
      <TabsContent value="b">Reviews panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("renders a tablist with named tabs and the active panel", () => {
    render(<Example />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Details panel");
  });
  it("switches panel on click", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("tab", { name: "Reviews" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Reviews panel");
  });
  it("moves between tabs with arrow keys", async () => {
    render(<Example />);
    screen.getByRole("tab", { name: "Details" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Reviews" })).toHaveFocus();
  });
});
