import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type DataColumn, DataTable } from "./DataTable";

type Row = { id: string; name: string; qty: number };
const columns: DataColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name },
  { key: "qty", header: "Qty", cell: (r) => r.qty, align: "right" },
];
const rows: Row[] = [
  { id: "1", name: "Tiffin", qty: 2 },
  { id: "2", name: "Comet", qty: 5 },
];

describe("DataTable", () => {
  it("renders a captioned table with column headers and rows", () => {
    render(<DataTable caption="Stock" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole("table", { name: "Stock" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Qty"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "Comet" })).toBeInTheDocument();
  });
  it("scrolls inside a focusable named region", () => {
    render(<DataTable caption="Stock" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const region = screen.getByRole("region", { name: "Stock" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("overflow-x-auto");
  });
  it("shows an empty state instead of the table", () => {
    render(<DataTable caption="Stock" columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="Nothing" />);
    expect(screen.getByRole("heading", { name: "Nothing" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
