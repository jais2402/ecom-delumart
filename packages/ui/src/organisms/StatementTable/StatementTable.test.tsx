import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatementTable } from "./StatementTable";

const rows = [
  {
    id: "1",
    date: "12 Mar",
    description: "Welcome grant",
    amountPaise: 1_000_00n,
    balanceAfterPaise: 1_000_00n,
  },
  { id: "2", date: "13 Mar", description: "Tiffin Box", amountPaise: -250_00n, balanceAfterPaise: 750_00n },
];

describe("StatementTable", () => {
  it("shows date, description, signed amount and balance after", () => {
    render(<StatementTable rows={rows} />);
    const table = screen.getByRole("table", { name: "Account statement" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Date", "Description", "Amount", "Balance after"]);
    expect(within(table).getByText("Welcome grant")).toBeInTheDocument();
  });
  it("states credit or debit in text and with a sign, not colour alone", () => {
    render(<StatementTable rows={rows} />);
    const [, credit, debit] = screen.getAllByRole("row");
    expect(credit).toHaveTextContent(/Credit\s*\+/);
    expect(debit).toHaveTextContent(/Debit\s*−/);
  });
  it("shows an empty state for no rows", () => {
    render(<StatementTable rows={[]} />);
    expect(screen.getByRole("heading", { name: "No transactions yet" })).toBeInTheDocument();
  });
});
