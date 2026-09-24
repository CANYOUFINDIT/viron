/** @vitest-environment happy-dom */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { TabulatorFull as Tabulator } from "tabulator-tables";
import { ElMessageBox } from "element-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({ api: vi.fn() }));

import { api } from "../src/client/api";
import TableDataEditor from "../src/client/components/TableDataEditor.vue";
import { i18nPlugin } from "../src/client/i18n";

const originalRows = [
  { id: "900000000000000001", update_time: "2026-09-12 16:00:07", name: "registry-one" },
  { id: "900000000000000002", update_time: "2026-09-12 16:00:14", name: "registry-two" },
  { id: "900000000000000003", update_time: "2026-09-12 16:00:15", name: "registry-three" },
];
const mockedApi = vi.mocked(api);
let wrapper: VueWrapper | undefined;
let table: Tabulator;
let errors: unknown[];
let clipboardWrite: ReturnType<typeof vi.fn>;
let clipboardRead: ReturnType<typeof vi.fn>;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, "vironDesktop");

beforeEach(async () => {
  // Supply layout dimensions so the real Tabulator renders its rows in happy-dom.
  for (const property of ["offsetWidth", "clientWidth", "offsetHeight", "clientHeight"] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockReturnValue(property.endsWith("Width") ? 1000 : 400);
  }
  const setInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!.set!;
  vi.spyOn(HTMLElement.prototype, "innerText", "set").mockImplementation(function (this: HTMLElement, value) {
    setInnerText.call(this, String(value));
  });
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path) => {
    if (path.includes("database-table-profiles")) return { items: [] };
    if (path.endsWith("/changes")) return { changed: 3 };
    return {
      columns: ["id", "update_time", "name"].map((name) => ({
        name, columnType: "varchar(255)", dataType: "varchar", nullable: name !== "id",
        defaultValue: null, primary: name === "id", unique: name === "id", autoIncrement: false, comment: "",
      })),
      primaryKey: ["id"], page: 1, pageSize: 100, total: 3,
      rows: structuredClone(originalRows),
    };
  });
  errors = [];
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  clipboardRead = vi.fn().mockResolvedValue("");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboardWrite, readText: clipboardRead } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  wrapper = mount(TableDataEditor, {
    attachTo: document.body,
    props: { connectionId: "fixture", database: "fixture", table: "images", active: true },
    global: {
      plugins: [i18nPlugin],
      config: { errorHandler: (error) => { errors.push(error); } },
      directives: { loading: {} },
      stubs: {
        "el-dropdown": { template: "<div><slot /></div>" },
        "el-dropdown-menu": true, "el-dropdown-item": true, "el-dialog": true,
        "el-input": true, "el-select": true, "el-option": true, "el-checkbox": true,
        "el-switch": true, "el-tooltip": { template: "<span><slot /></span>" },
        "el-button": true, "el-form-item": true, "el-form": true, "el-radio-button": true, "el-radio-group": true,
      },
    },
  });
  await flushPromises();
  table = Tabulator.findTable(wrapper.get(".editable-data-grid").element as HTMLElement)[0];
  await vi.waitFor(() => expect(table.getRows()).toHaveLength(3));
});

afterEach(async () => {
  // Tabulator schedules range layout on a timer even after the menu action resolves.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (originalSecureContext) Object.defineProperty(window, "isSecureContext", originalSecureContext);
  else Reflect.deleteProperty(window, "isSecureContext");
  if (originalDesktopBridge) Object.defineProperty(window, "vironDesktop", originalDesktopBridge);
  else Reflect.deleteProperty(window, "vironDesktop");
});

async function selectRange(firstField = "update_time", lastField = firstField) {
  const rows = table.getRows();
  table.addRange(rows[0].getCell(firstField), rows[2].getCell(lastField));
  await flushPromises();
  expect(table.getRanges()).toHaveLength(1);
  const fields = table.getColumns().map((column) => column.getField());
  const width = Math.abs(fields.indexOf(lastField) - fields.indexOf(firstField)) + 1;
  await vi.waitFor(() => expect(table.getRanges()[0].getCells().flat()).toHaveLength(width * 3));
}

async function press(key: string) {
  await wrapper!.get('.tabulator-row .tabulator-cell[tabulator-field="update_time"]').trigger("keydown", { key });
  await flushPromises();
  expect(errors).toEqual([]);
}

function values(field = "update_time") {
  return table.getData().map((row) => row[field]);
}

describe("table data editor range fill with real Tabulator components", () => {
  it("previews multi-row typing and restores the original values with Escape", async () => {
    await selectRange();
    await press("x");
    expect(wrapper!.get<HTMLInputElement>(".table-range-fill-input").element.value).toBe("x");
    expect(wrapper!.get(".editable-data-grid").classes()).toEqual(expect.arrayContaining(["tabulator", "tabulator-ranges"]));
    expect(values()).toEqual(["x", "x", "x"]);
    await wrapper!.get(".table-range-fill-input").setValue("2026-09-12 17:00:00");
    expect(values()).toEqual(Array(3).fill("2026-09-12 17:00:00"));
    await wrapper!.get(".table-range-fill-input").trigger("keydown", { key: "Escape" });
    expect(values()).toEqual(originalRows.map((row) => row.update_time));
    expect(wrapper!.find(".table-range-fill-input").exists()).toBe(false);
    expect(wrapper!.get(".editable-data-grid").classes()).toEqual(expect.arrayContaining(["tabulator", "tabulator-ranges"]));
    expect(wrapper!.get('[data-navicat-action="commit"]').attributes("disabled")).toBeDefined();
    expect(errors).toEqual([]);
  });

  it.each(["Enter", "F2", "dblclick"])("opens the current value with %s and commits all selected rows using their original keys", async (trigger) => {
    await selectRange();
    if (trigger === "dblclick") {
      await wrapper!.get('.tabulator-row .tabulator-cell[tabulator-field="update_time"]').trigger("dblclick");
      expect(errors).toEqual([]);
    } else await press(trigger);
    const input = wrapper!.get<HTMLInputElement>(".table-range-fill-input");
    expect(input.element.value).toBe(originalRows[0].update_time);
    await input.setValue("2026-09-12 18:00:00");
    await input.trigger("keydown", { key: "Enter" });
    await wrapper!.get('[data-navicat-action="commit"]').trigger("click");
    await flushPromises();
    const save = mockedApi.mock.calls.find(([path]) => path.endsWith("/changes"));
    expect(save).toBeDefined();
    expect(JSON.parse(save![1]!.body as string)).toEqual({
      database: "fixture", table: "images",
      changes: originalRows.map((row) => ({
        type: "update", key: { id: row.id }, values: { ...row, update_time: "2026-09-12 18:00:00" },
      })),
    });
    expect(errors).toEqual([]);
  });

  it("clears a rectangular range, protects primary keys, and undoes the pending changes", async () => {
    await selectRange("id", "name");
    await press("Delete");
    expect(values("id")).toEqual(originalRows.map((row) => row.id));
    expect(values()).toEqual([null, null, null]);
    expect(values("name")).toEqual([null, null, null]);
    await press("Escape");
    expect(values()).toEqual(originalRows.map((row) => row.update_time));
    expect(values("name")).toEqual(originalRows.map((row) => row.name));
    expect(wrapper!.get('[data-navicat-action="commit"]').attributes("disabled")).toBeDefined();
  });
});

describe("table data row context menu", () => {
  async function openMenu(field = "update_time") {
    await wrapper!.get(`.tabulator-row .tabulator-cell[tabulator-field="${field}"]`).trigger("contextmenu", { clientX: 200, clientY: 200 });
    await flushPromises();
    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(document.querySelector(".table-row-context-menu")).not.toBeNull());
  }

  async function choose(action: string) {
    document.querySelector<HTMLButtonElement>(`.table-row-context-menu [data-action="${action}"]`)!.click();
    await flushPromises();
    expect(errors).toEqual([]);
  }

  it("preserves a selected multi-row range and copies each row as an INSERT statement", async () => {
    await selectRange("update_time", "name");
    await openMenu();
    await choose("copy-insert");
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const copied = clipboardWrite.mock.calls[0][0] as string;
    expect(copied.split("\n")).toHaveLength(3);
    expect(copied).toContain("INSERT INTO `fixture`.`images` (`id`, `update_time`, `name`) VALUES ('900000000000000001'");
    expect(copied).toContain("'registry-three');");
  });

  it("pastes a rectangle through the pending-change workflow without changing primary keys", async () => {
    await openMenu("update_time");
    clipboardRead.mockResolvedValue("2026-09-12 18:00:00\tchanged-one\n2026-09-12 19:00:00\tchanged-two");
    await choose("paste");
    expect(values("id")).toEqual(originalRows.map((row) => row.id));
    expect(values()).toEqual(["2026-09-12 18:00:00", "2026-09-12 19:00:00", originalRows[2].update_time]);
    expect(values("name")).toEqual(["changed-one", "changed-two", originalRows[2].name]);
    await wrapper!.get('[data-navicat-action="commit"]').trigger("click");
    await flushPromises();
    const save = mockedApi.mock.calls.find(([path]) => path.endsWith("/changes"));
    expect(JSON.parse(save![1]!.body as string).changes).toEqual(originalRows.slice(0, 2).map((row, index) => ({
      type: "update", key: { id: row.id }, values: {
        ...row, update_time: index === 0 ? "2026-09-12 18:00:00" : "2026-09-12 19:00:00",
        name: index === 0 ? "changed-one" : "changed-two",
      },
    })));
  });

  it("selects the whole record from its row header and copies all visible fields", async () => {
    await wrapper!.get(".tabulator-row .tabulator-cell.table-row-header").trigger("contextmenu", { clientX: 200, clientY: 200 });
    await flushPromises();
    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(document.querySelector(".table-row-context-menu")).not.toBeNull());
    await choose("copy");
    expect(clipboardWrite).toHaveBeenCalledWith("900000000000000001\t2026-09-12 16:00:07\tregistry-one");
  });

  it("copies the clicked field name separately from tab separated selection headers", async () => {
    await selectRange("update_time", "name");
    await openMenu("name");
    await choose("copy-names");
    expect(clipboardWrite).toHaveBeenLastCalledWith("name");
    await openMenu("name");
    await choose("copy-field-names");
    expect(clipboardWrite).toHaveBeenLastCalledWith("update_time\tname");
  });

  it("sets a custom data row height from the context menu", async () => {
    vi.spyOn(ElMessageBox, "prompt").mockResolvedValue({ value: "48" } as Awaited<ReturnType<typeof ElMessageBox.prompt>>);
    await openMenu();
    await choose("row-height");
    expect(wrapper!.get<HTMLElement>(".editable-data-grid").element.style.getPropertyValue("--table-data-row-height")).toBe("48px");
  });

  it("marks a right-clicked record for deletion until changes are committed", async () => {
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm");
    await openMenu();
    expect(document.querySelector<HTMLButtonElement>('.table-row-context-menu [data-action="delete"]')?.disabled).toBe(false);
    await choose("delete");
    expect(table.getRows()[0].getElement().classList.contains("is-pending-delete")).toBe(true);
    expect(mockedApi.mock.calls.some(([path]) => path.endsWith("/changes"))).toBe(false);
    await wrapper!.get('[data-navicat-action="commit"]').trigger("click");
    await flushPromises();
    const save = mockedApi.mock.calls.find(([path]) => path.endsWith("/changes"));
    expect(JSON.parse(save![1]!.body as string).changes).toEqual([{ type: "delete", values: {}, key: { id: originalRows[0].id } }]);
  });

  function installDesktopBridge() {
    const desktopWrite = vi.fn().mockResolvedValue({ written: true });
    const desktopRead = vi.fn().mockResolvedValue("native-value");
    Object.defineProperty(window, "vironDesktop", { configurable: true, value: {
      writeClipboardText: desktopWrite, readClipboardText: desktopRead,
    } });
    clipboardWrite.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    clipboardRead.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    return { desktopWrite, desktopRead };
  }

  it("copies through the desktop native clipboard bridge when browser access is denied", async () => {
    const { desktopWrite } = installDesktopBridge();
    await openMenu("id");
    await choose("copy-names");
    expect(desktopWrite).toHaveBeenCalledWith("id");
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("pastes through the desktop native clipboard bridge when browser access is denied", async () => {
    const { desktopRead } = installDesktopBridge();
    await openMenu("update_time");
    await choose("paste");
    expect(desktopRead).toHaveBeenCalledOnce();
    expect(clipboardRead).not.toHaveBeenCalled();
    expect(values()[0]).toBe("native-value");
  });
});
