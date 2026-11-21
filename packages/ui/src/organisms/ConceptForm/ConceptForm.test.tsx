import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConceptForm } from "./ConceptForm";

const long = "A teapot that pours any weather you ask for.";

describe("ConceptForm", () => {
  it("names the field, explains it is private and shows a live count", async () => {
    render(<ConceptForm minChars={20} maxChars={280} onSubmit={() => {}} />);
    const field = screen.getByRole("textbox", { name: "Your invention concept" });
    expect(field).toHaveAccessibleDescription("Only you can see this. It is never published.");
    await userEvent.type(field, "hello");
    expect(screen.getByText("5 of 280 characters (at least 20)")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("5 of 280 characters"));
  });
  it("refuses a short concept with a field message, then submits a good one trimmed", async () => {
    const onSubmit = vi.fn();
    render(<ConceptForm minChars={20} maxChars={280} onSubmit={onSubmit} />);
    const field = screen.getByRole("textbox", { name: "Your invention concept" });
    await userEvent.type(field, "too short");
    await userEvent.click(screen.getByRole("button", { name: "Save my concept" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(/Write at least 20 characters/);
    await userEvent.clear(field);
    await userEvent.type(field, `  ${long}  `);
    await userEvent.click(screen.getByRole("button", { name: "Save my concept" }));
    expect(onSubmit).toHaveBeenCalledWith(long);
  });
  it("shows the server's reasons on the field", () => {
    render(
      <ConceptForm
        minChars={20}
        maxChars={280}
        initialText={long}
        onSubmit={() => {}}
        reasons={["Remove the link."]}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Your invention concept" })).toHaveAccessibleDescription(
      /Remove the link\./,
    );
  });
});
