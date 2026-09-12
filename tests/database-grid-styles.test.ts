import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/client/styles/base.css", import.meta.url), "utf8");

describe("database grid styles", () => {
  it("uses Tabulator row parity instead of virtual DOM child order", () => {
    expect(styles).toContain(".query-result-grid .tabulator-row.tabulator-row-even { background: #101c1e; }");
    expect(styles).toContain(".editable-data-grid .tabulator-row.tabulator-row-even { background: #101c1e; }");
    expect(styles).toContain(":root.bright .query-result-grid .tabulator-row.tabulator-row-even,");
    expect(styles).toContain(":root.bright .editable-data-grid .tabulator-row.tabulator-row-even { background: #f5f8f8; }");
    expect(styles).not.toContain(".query-result-grid .tabulator-row:nth-child(even)");
    expect(styles).not.toContain(".editable-data-grid .tabulator-row:nth-child(even)");
  });

  it("covers the grid viewport and virtual table canvas with the active theme background", () => {
    expect(styles).toContain(".query-result-grid.tabulator { border: 0; background: #0c1719;");
    expect(styles).toContain(".editable-data-grid.tabulator { border: 0; background: #0c1719;");
    expect(styles).toContain(".query-result-grid.tabulator .tabulator-tableholder,");
    expect(styles).toContain(".query-result-grid.tabulator .tabulator-tableholder .tabulator-table { background-color: #0c1719; }");
    expect(styles).toContain(".editable-data-grid.tabulator .tabulator-tableholder,");
    expect(styles).toContain(".editable-data-grid.tabulator .tabulator-tableholder .tabulator-table { background-color: #0c1719; }");
    expect(styles).toContain(":root.bright .query-result-grid.tabulator,");
    expect(styles).toContain(":root.bright .editable-data-grid.tabulator { background: #fbfcfd; color: #24363b; }");
    expect(styles).toContain(":root.bright .query-result-grid.tabulator .tabulator-tableholder,");
    expect(styles).toContain(":root.bright .query-result-grid.tabulator .tabulator-tableholder .tabulator-table,");
    expect(styles).toContain(":root.bright .editable-data-grid.tabulator .tabulator-tableholder,");
    expect(styles).toContain(":root.bright .editable-data-grid.tabulator .tabulator-tableholder .tabulator-table { background-color: #fbfcfd; }");
    expect(styles).not.toContain(".query-result-grid .tabulator { border: 0;");
    expect(styles).not.toContain(".editable-data-grid .tabulator { border: 0;");
  });

  it("keeps selected and sorted header text readable in dark and bright themes", () => {
    expect(styles).toContain(".database-object-table tbody tr.is-selected,");
    expect(styles).toContain(".database-object-table tbody tr.is-selected:nth-child(even),");
    expect(styles).toContain(".database-object-table tbody tr.is-selected:hover,");
    expect(styles).toContain(".database-object-table tbody tr.is-selected:focus-visible { background: #175caa; color: #fff; }");
    expect(styles).toContain(":root.bright .database-object-table tbody tr.is-selected,");
    expect(styles).toContain(":root.bright .database-object-table tbody tr.is-selected:nth-child(even),");
    expect(styles).toContain(":root.bright .database-object-table tbody tr.is-selected:hover,");
    expect(styles).toContain(":root.bright .database-object-table tbody tr.is-selected:focus-visible { background: #cfe6de; color: #16332f; }");
    expect(styles).toContain(".query-result-grid.tabulator .tabulator-header .tabulator-col.tabulator-sortable.tabulator-col-sorter-element:hover,");
    expect(styles).toContain(".editable-data-grid.tabulator .tabulator-header .tabulator-col.tabulator-sortable.tabulator-col-sorter-element:hover,");
    expect(styles).toContain(".editable-data-grid.tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=\"descending\"] { background: #1d3532; color: #e8f4f0; }");
    expect(styles).toContain(":root.bright .editable-data-grid.tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=\"descending\"] { background: #d4ebe3; color: #16332f; }");
    expect(styles).toContain(".query-result-grid .tabulator-row.tabulator-selected,");
    expect(styles).toContain(".editable-data-grid .tabulator-row.tabulator-selected,");
    expect(styles).toContain(":root.bright .editable-data-grid .tabulator-row.tabulator-selected:hover { background: #cfe6de; color: #16332f; }");
  });
});
